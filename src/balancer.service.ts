import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import {
  Agent as HttpAgent,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { ROUTE_BALANCER_OPTIONS, ROUTE_BALANCER_PLUGINS, routeMatches, validateOptions } from './options';
import {
  BalancerMetrics,
  RateLimitDecision,
  RouteBalancerOptions,
  RuntimeRouteReloadResult,
  RouteBalancerPlugin,
  RouteBalancerRequestContext,
  RouteState,
  UpstreamState,
} from './types';
import { hasStrategy, selectUpstream } from './strategies/select';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const RETRY_BUDGET_WINDOW_MS = 60000;

interface RetryWindow {
  requests: number[];
  retries: number[];
}

interface RateLimitBucket {
  tokens: number;
  updatedAt: number;
}

export interface CachedResponse {
  key: string;
  routePath: string;
  pathname: string;
  status: number;
  headers: OutgoingHttpHeaders;
  body: Buffer;
  storedAt: number;
  expiresAt: number;
  size: number;
  head: boolean;
}

interface CacheUsage {
  entries: number;
  bytes: number;
}

function cacheHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(',').trim();
  return (value ?? '').trim();
}

interface RequestLifecycle {
  signal: AbortSignal;
  abort: () => void;
  done: () => void;
}

export class RequestInterceptionError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'RequestInterceptionError';
  }
}

const FORBIDDEN_PLUGIN_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'proxy-connection', 'host', 'content-length', 'expect',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-request-id',
]);

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function validatePluginPath(route: RouteState, pathname: unknown): string {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')
    || /[?#%\\\\\r\n\0]/.test(pathname)) {
    throw new RequestInterceptionError(400, 'Request plugin returned an invalid path');
  }
  let normalized: string;
  try {
    let decoded = pathname;
    for (let pass = 0; pass < 8; pass += 1) {
      if (/%(?:2f|5c|2e)/i.test(decoded)) throw new Error('Encoded path separator or dot segment');
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    if (decoded.includes('\\') || /[?#%\r\n\0]/.test(decoded)
      || decoded.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('Unsafe path');
    const base = new URL('http://plugin-path.invalid');
    const parsed = new URL(pathname, base);
    if (parsed.origin !== base.origin || parsed.search || parsed.hash) throw new Error('Invalid path');
    normalized = parsed.pathname;
  } catch {
    throw new RequestInterceptionError(400, 'Request plugin returned an invalid path');
  }
  if (!routeMatches(route.path, normalized)) {
    throw new RequestInterceptionError(400, 'Request plugin cannot move a request outside its matched route');
  }
  return normalized;
}

@Injectable()
export class RouteBalancerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RouteBalancerService.name);
  private routes: RouteState[];
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly controllers = new Set<AbortController>();
  private readonly inFlight = new Set<AbortController>();
  private readonly healthChecksInFlight = new Set<string>();
  private readonly halfOpenCount = new Map<string, number>();
  private readonly failureWindow = new Map<string, number[]>();
  private readonly requestWindow = new Map<string, number[]>();
  private readonly retryWindow = new Map<string, RetryWindow>();
  private readonly rateLimits = new Map<string, RateLimitBucket>();
  private readonly cache = new Map<string, CachedResponse>();
  private readonly cacheUsage = new Map<string, CacheUsage>();
  private readonly cacheFills = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  private readonly shutdownTimeoutMs: number;
  private shuttingDown = false;
  private destroyed = false;
  options: RouteBalancerOptions;
  readonly defaultStickySecret: string;
  readonly httpAgent: HttpAgent;
  readonly httpsAgent: HttpsAgent;

  constructor(
    @Inject(ROUTE_BALANCER_OPTIONS) options: RouteBalancerOptions,
    @Optional() @Inject(ROUTE_BALANCER_PLUGINS) readonly requestPlugins: readonly RouteBalancerPlugin[] = [],
  ) {
    this.options = options;
    this.routes = this.buildRoutes(options);
    if (!Array.isArray(requestPlugins) || requestPlugins.length > 32
      || requestPlugins.some(plugin => !plugin || typeof plugin.onRequest !== 'function')) {
      throw new Error('Request plugins must be an array of at most 32 items implementing onRequest(context)');
    }
    this.requestPlugins = Object.freeze([...requestPlugins]);
    const agentOptions = { keepAlive: options.keepAlive ?? true, maxSockets: options.maxSockets ?? 128 };
    this.httpAgent = new HttpAgent(agentOptions);
    this.httpsAgent = new HttpsAgent(agentOptions);
    this.defaultStickySecret = randomBytes(32).toString('hex');
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }

  private buildRoutes(options: RouteBalancerOptions): RouteState[] {
    const routes = validateOptions(options);
    for (const route of routes) {
      if (!hasStrategy(route.config.strategy ?? 'round-robin')) throw new Error(`Unknown strategy: ${route.config.strategy}`);
    }
    return routes.sort((a, b) => b.path.length - a.path.length);
  }

  findRoute(pathname: string): RouteState | undefined {
    return this.routes.find(route => routeMatches(route.path, pathname));
  }

  /**
   * Stops selecting an upstream while letting in-flight requests finish. Returns false
   * when the route path or upstream origin is unknown.
   */
  drainUpstream(routePath: string, upstreamUrl: string): boolean {
    const node = this.runtimeNode(routePath, upstreamUrl);
    if (!node) return false;
    node.drained = true;
    this.log.warn(`Upstream drained: ${node.url} (${routePath})`);
    return true;
  }

  /** Re-enables a drained upstream. Circuit and ejection state are untouched. */
  resumeUpstream(routePath: string, upstreamUrl: string): boolean {
    const node = this.runtimeNode(routePath, upstreamUrl);
    if (!node) return false;
    node.drained = false;
    this.log.log(`Upstream resumed: ${node.url} (${routePath})`);
    return true;
  }

  /** Changes an upstream weight at runtime; the configured value wins on the next reload. */
  setUpstreamWeight(routePath: string, upstreamUrl: string, weight: number): boolean {
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > 1000) {
      throw new Error('weight must be an integer between 1 and 1000');
    }
    const node = this.runtimeNode(routePath, upstreamUrl);
    if (!node) return false;
    node.weight = weight;
    return true;
  }

  /**
   * Atomically replaces the route table. Untouched upstreams keep counters, circuit
   * state and drain flags; in-flight requests finish against the previous snapshot.
   * `trustProxy`, `maxSockets`, `keepAlive`, `shutdownTimeoutMs`, `ssrf` and
   * `requestInterception` are bootstrap-only and must not change here.
   */
  reloadRoutes(options: RouteBalancerOptions): RuntimeRouteReloadResult {
    if (this.destroyed || this.shuttingDown) throw new Error('Route balancer is shutting down');
    const changedStatics = this.changedStaticOptions(options);
    if (changedStatics.length > 0) {
      throw new Error(`Cannot change ${changedStatics.join(', ')} at runtime; restart the application`);
    }

    const incoming = this.buildRoutes(options);
    const previous = new Map(this.routes.map(route => [route.path, route]));
    for (const route of incoming) {
      const old = previous.get(route.path);
      if (!old) continue;
      for (const node of route.upstreams) {
        const oldNode = old.upstreams.find(candidate => candidate.url === node.url);
        if (oldNode) this.carryOverState(oldNode, node);
      }
    }

    const nextPaths = new Set(incoming.map(route => route.path));
    const added = incoming.filter(route => !previous.has(route.path)).map(route => route.path);
    const removed = this.routes.filter(route => !nextPaths.has(route.path)).map(route => route.path);
    const updated = incoming
      .filter(route => {
        const old = previous.get(route.path);
        return old !== undefined && this.routeSignature(old) !== this.routeSignature(route);
      })
      .map(route => route.path);

    this.routes = incoming;
    this.options = options;
    // Half-open bookkeeping is scoped to the previous snapshot; probes finish there.
    this.halfOpenCount.clear();
    this.pruneRuntimeState();
    // Limits may have changed, so buckets and cached variants are discarded.
    this.rateLimits.clear();
    this.clearCache();
    for (const key of [...this.cacheFills.keys()]) this.endCacheFill(key);
    this.restartTimers();
    for (const route of this.routes) {
      if (route.config.healthCheck) void this.checkRoute(route);
    }
    this.log.log(`Routes reloaded: +${added.length} -${removed.length} ~${updated.length}`);
    return { added, removed, updated };
  }

  private changedStaticOptions(next: RouteBalancerOptions): string[] {
    const fields: Array<'trustProxy' | 'maxSockets' | 'keepAlive' | 'shutdownTimeoutMs' | 'ssrf' | 'requestInterception'> = [
      'trustProxy', 'maxSockets', 'keepAlive', 'shutdownTimeoutMs', 'ssrf', 'requestInterception',
    ];
    return fields.filter(field => stableStringify(this.options[field]) !== stableStringify(next[field]));
  }

  private routeSignature(route: RouteState): string {
    return `${stableStringify(route.config)}|${route.upstreams.map(node => `${node.url}:${node.weight}`).join(',')}`;
  }

  private carryOverState(from: UpstreamState, to: UpstreamState): void {
    to.healthy = from.healthy;
    to.drained = from.drained;
    to.requests = from.requests;
    to.errors = from.errors;
    to.successes = from.successes;
    to.retries = from.retries;
    to.healthCheckSuccesses = from.healthCheckSuccesses;
    to.healthCheckFailures = from.healthCheckFailures;
    to.consecutiveFailures = from.consecutiveFailures;
    to.consecutive5xx = from.consecutive5xx;
    to.blockedUntil = from.blockedUntil;
    to.totalResponseTimeMs = from.totalResponseTimeMs;
    to.responseCount = from.responseCount;
    to.ewmaResponseTimeMs = from.ewmaResponseTimeMs;
    to.ewmaObservedAt = from.ewmaObservedAt;
    to.ejectedUntil = from.ejectedUntil;
    to.ejectionCount = from.ejectionCount;
    to.lastFailureAt = from.lastFailureAt;
    to.lastEjectionAt = from.lastEjectionAt;
  }

  private runtimeNode(routePath: string, upstreamUrl: string): UpstreamState | undefined {
    const route = this.routes.find(candidate => candidate.path === routePath);
    if (!route) return undefined;
    let origin = upstreamUrl;
    try {
      origin = new URL(upstreamUrl).origin;
    } catch {
      // Keep the raw value so unknown inputs simply do not match.
    }
    return route.upstreams.find(node => node.url === origin);
  }

  private restartTimers(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    for (const route of this.routes) {
      const intervalMs = route.config.healthCheck?.intervalMs;
      if (intervalMs) {
        const timer = setInterval(() => { void this.checkRoute(route); }, intervalMs);
        timer.unref();
        this.timers.push(timer);
      }
      if (route.config.outlierDetection) {
        const interval = route.config.outlierDetection.intervalMs ?? 30000;
        const timer = setInterval(() => this.maintainOutliers(route, interval), interval);
        timer.unref();
        this.timers.push(timer);
      }
    }
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  registerRequest(): RequestLifecycle {
    const controller = new AbortController();
    this.inFlight.add(controller);
    return {
      signal: controller.signal,
      abort: () => controller.abort(),
      done: () => {
        this.inFlight.delete(controller);
      },
    };
  }

  async interceptRequest(
    route: RouteState,
    input: Omit<RouteBalancerRequestContext, 'routePath' | 'signal'>,
    parentSignal: AbortSignal,
  ): Promise<{ pathname: string; headers: Record<string, string | null> }> {
    const plugins = this.requestPlugins;
    const allowedHeaders = new Set((this.options.requestInterception?.allowedHeaders ?? []).map(name => name.toLowerCase()));
    const timeoutMs = this.options.requestInterception?.timeoutMs ?? 1000;
    const exposedHeaders = new Set((this.options.requestInterception?.exposedHeaders ?? []).map(name => name.toLowerCase()));
    const safeInputHeaders = Object.fromEntries(Object.entries(input.headers)
      .filter(([name]) => exposedHeaders.has(name.toLowerCase())));
    const result: { pathname: string; headers: Record<string, string | null> } = {
      pathname: input.pathname,
      headers: Object.create(null) as Record<string, string | null>,
    };
    if (plugins.length === 0) return result;

    const controller = new AbortController();
    const abortFromParent = (): void => controller.abort(parentSignal.reason);
    if (parentSignal.aborted) abortFromParent();
    else parentSignal.addEventListener('abort', abortFromParent, { once: true });

    let timeout: NodeJS.Timeout | undefined;
    let timedOut = false;
    let rejectDeadline: ((error: RequestInterceptionError) => void) | undefined;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const abortDeadline = (): void => rejectDeadline?.(new RequestInterceptionError(
      timedOut ? 504 : 503,
      timedOut ? 'Request interception timed out' : 'Request interception was cancelled',
    ));
    controller.signal.addEventListener('abort', abortDeadline, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('Request plugin timeout'));
    }, timeoutMs);
    timeout.unref?.();

    const run = async (): Promise<void> => {
      const immutableHeaders = Object.freeze(Object.fromEntries(
        Object.entries(safeInputHeaders).map(([name, value]) => [name, Array.isArray(value) ? Object.freeze([...value]) : value]),
      ));
      const context: RouteBalancerRequestContext = Object.freeze({
        ...input,
        headers: immutableHeaders,
        routePath: route.path,
        signal: controller.signal,
      });
      for (const plugin of plugins) {
        if (controller.signal.aborted) {
          throw new RequestInterceptionError(timedOut ? 504 : 503, timedOut ? 'Request interception timed out' : 'Request interception was cancelled');
        }
        let decision;
        try {
          decision = await plugin.onRequest(context);
        } catch (error) {
          if (controller.signal.aborted) {
            throw new RequestInterceptionError(timedOut ? 504 : 503, timedOut ? 'Request interception timed out' : 'Request interception was cancelled');
          }
          throw new RequestInterceptionError(500, 'Request interception failed');
        }
        if (controller.signal.aborted) {
          throw new RequestInterceptionError(timedOut ? 504 : 503, timedOut ? 'Request interception timed out' : 'Request interception was cancelled');
        }
        if (decision === undefined) continue;
        if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
          throw new RequestInterceptionError(500, 'Request plugin returned an invalid decision');
        }
        const keys = Object.keys(decision);
        if (keys.some(key => key !== 'pathname' && key !== 'headers' && key !== 'reject')) {
          throw new RequestInterceptionError(500, 'Request plugin returned unsupported modifications');
        }
        if (decision.reject !== undefined) {
          const rejection = decision.reject;
          if (!rejection || typeof rejection !== 'object' || Array.isArray(rejection)
            || Object.keys(rejection).some(key => key !== 'statusCode' && key !== 'message')
            || !Number.isSafeInteger(rejection.statusCode) || rejection.statusCode < 400 || rejection.statusCode > 599
            || (rejection.message !== undefined && (typeof rejection.message !== 'string' || rejection.message.length > 256))) {
            throw new RequestInterceptionError(500, 'Request plugin returned an invalid rejection');
          }
          throw new RequestInterceptionError(rejection.statusCode, rejection.message ?? 'Request rejected by policy');
        }
        if (decision.pathname !== undefined) result.pathname = validatePluginPath(route, decision.pathname);
        if (decision.headers !== undefined) {
          if (!decision.headers || typeof decision.headers !== 'object' || Array.isArray(decision.headers)) {
            throw new RequestInterceptionError(500, 'Request plugin returned invalid headers');
          }
          for (const [name, value] of Object.entries(decision.headers)) {
            const normalizedName = name.toLowerCase();
            if (name.length > 256 || !/^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/.test(name) || !allowedHeaders.has(normalizedName)
              || FORBIDDEN_PLUGIN_HEADERS.has(normalizedName)) {
              throw new RequestInterceptionError(500, 'Request plugin attempted to modify a protected header');
            }
            if (value !== null && (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value))) {
              throw new RequestInterceptionError(500, 'Request plugin returned an invalid header value');
            }
            result.headers[normalizedName] = value;
          }
        }
      }
    };

    try {
      await Promise.race([run(), deadline]);
      if (controller.signal.aborted) {
        throw new RequestInterceptionError(timedOut ? 504 : 503, timedOut ? 'Request interception timed out' : 'Request interception was cancelled');
      }
      return result;
    } finally {
      if (timeout) clearTimeout(timeout);
      controller.signal.removeEventListener('abort', abortDeadline);
      parentSignal.removeEventListener('abort', abortFromParent);
    }
  }

  private routeKey(route: RouteState): string {
    return route.path;
  }

  private nodeKey(route: RouteState, node: UpstreamState): string {
    return `${route.path}:${node.url}`;
  }

  private routeFor(node: UpstreamState): RouteState | undefined {
    return this.routes.find(route => route.upstreams.includes(node));
  }

  private pruneRuntimeState(): void {
    const routeKeys = new Set<string>();
    const nodeKeys = new Set<string>();
    for (const route of this.routes) {
      routeKeys.add(this.routeKey(route));
      for (const node of route.upstreams) nodeKeys.add(this.nodeKey(route, node));
    }
    for (const key of [...this.failureWindow.keys()]) {
      if (!nodeKeys.has(key)) this.failureWindow.delete(key);
    }
    for (const key of [...this.requestWindow.keys()]) {
      if (!nodeKeys.has(key)) this.requestWindow.delete(key);
    }
    for (const key of [...this.retryWindow.keys()]) {
      if (!routeKeys.has(key)) this.retryWindow.delete(key);
    }
  }

  private pruneWindow(values: number[], now: number, windowMs: number): number[] {
    let index = 0;
    while (index < values.length && now - values[index] >= windowMs) index += 1;
    if (index > 0) values.splice(0, index);
    return values;
  }

  private capWindow(values: number[]): number[] {
    const limit = 10000;
    if (values.length > limit) values.splice(0, values.length - limit);
    return values;
  }

  private noteRequest(route: RouteState, node: UpstreamState, now: number): void {
    const routeKey = this.routeKey(route);
    const window = this.retryWindow.get(routeKey) ?? { requests: [], retries: [] };
    window.requests.push(now);
    this.pruneWindow(window.requests, now, RETRY_BUDGET_WINDOW_MS);
    this.capWindow(window.requests);
    this.retryWindow.set(routeKey, window);

    const key = this.nodeKey(route, node);
    const nodeWindow = this.requestWindow.get(key) ?? [];
    nodeWindow.push(now);
    const windowMs = (route.config.circuitBreaker?.slidingWindowSize ?? 60) * 1000;
    this.pruneWindow(nodeWindow, now, windowMs);
    this.capWindow(nodeWindow);
    this.requestWindow.set(key, nodeWindow);
  }

  /**
   * Consumes one token from the route's local token bucket. Returns `undefined` when
   * the route has no rate limit configured. Buckets are process-local.
   */
  checkRateLimit(route: RouteState, remoteAddress: string | undefined, headers: IncomingHttpHeaders): RateLimitDecision | undefined {
    const config = route.config.rateLimit;
    if (!config) return undefined;

    const now = Date.now();
    const identity = this.rateLimitIdentity(config.key ?? 'ip', config.header, remoteAddress, headers);
    const key = `${config.perRoute === false ? '*' : route.path}:${identity}`;
    const limit = config.limit;
    const refillPerMs = limit / config.windowMs;

    let bucket = this.rateLimits.get(key);
    if (bucket) {
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(limit, bucket.tokens + elapsed * refillPerMs);
    } else {
      bucket = { tokens: limit, updatedAt: now };
    }
    bucket.updatedAt = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    else route.rateLimited += 1;

    // Refresh LRU order and enforce the memory bound.
    this.rateLimits.delete(key);
    this.rateLimits.set(key, bucket);
    const maxKeys = config.maxKeys ?? 10000;
    while (this.rateLimits.size > maxKeys) {
      const oldest = this.rateLimits.keys().next().value;
      if (oldest === undefined) break;
      this.rateLimits.delete(oldest);
    }

    const missing = Math.max(0, limit - bucket.tokens);
    return {
      allowed,
      limit,
      remaining: Math.floor(bucket.tokens),
      resetSeconds: Math.max(0, Math.ceil(missing / refillPerMs / 1000)),
      retryAfterSeconds: allowed ? undefined : Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerMs / 1000)),
    };
  }

  /** Clears every local rate-limit bucket (useful after configuration changes). */
  resetRateLimits(): void {
    this.rateLimits.clear();
  }

  /**
   * Computes the cache key for a request. `accept-encoding` is always part of the
   * signature, and configured `vary` headers are appended in sorted order.
   */
  cacheContextFor(
    route: RouteState,
    method: string,
    pathname: string,
    search: string,
    headers: IncomingHttpHeaders,
  ): { key: string; vary: string[] } | undefined {
    const cache = route.config.cache;
    if (!cache) return undefined;
    const vary = [...new Set(['accept-encoding', ...(cache.vary ?? []).map(name => name.toLowerCase())])].sort();
    const signature = vary.map(name => `${name}=${cacheHeaderValue(headers[name])}`).join('&');
    return {
      key: `${route.path}\u0000${method}\u0000${pathname}${search}\u0000${signature}`,
      vary,
    };
  }

  /** Returns a fresh cache entry and records the hit. Expired entries are dropped on read. */
  getCached(route: RouteState, key: string): CachedResponse | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      route.cacheMisses += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.removeCacheEntry(entry);
      route.cacheMisses += 1;
      return undefined;
    }
    route.cacheHits += 1;
    // Refresh LRU order.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry;
  }

  /** Stores a fully buffered response, enforcing per-route entry and byte budgets. */
  storeCache(
    route: RouteState,
    request: { key: string; pathname: string; head: boolean },
    response: { status: number; headers: OutgoingHttpHeaders; body: Buffer; ttlMs: number },
  ): void {
    const cache = route.config.cache;
    if (!cache || !this.routes.includes(route)) return;
    const maxEntryBytes = cache.maxEntryBytes ?? 1_048_576;
    if (response.body.length > maxEntryBytes) return;
    const ttlMs = Math.min(cache.ttlMs, response.ttlMs);
    if (!(ttlMs > 0)) return;

    const existing = this.cache.get(request.key);
    if (existing) this.removeCacheEntry(existing);

    const now = Date.now();
    const entry: CachedResponse = {
      key: request.key,
      routePath: route.path,
      pathname: request.pathname,
      status: response.status,
      headers: response.headers,
      body: response.body,
      storedAt: now,
      expiresAt: now + ttlMs,
      size: response.body.length,
      head: request.head,
    };
    this.cache.set(entry.key, entry);
    const usage = this.cacheUsage.get(route.path) ?? { entries: 0, bytes: 0 };
    usage.entries += 1;
    usage.bytes += entry.size;
    this.cacheUsage.set(route.path, usage);
    route.cacheStores += 1;
    this.evictCache(route, cache.maxEntries ?? 1000, cache.maxBytes ?? 50 * 1024 * 1024);
  }

  /** Drops cached variants for one pathname after an unsafe method touches it. */
  invalidateCache(route: RouteState, pathname: string): void {
    for (const entry of [...this.cache.values()]) {
      if (entry.routePath === route.path && entry.pathname === pathname) this.removeCacheEntry(entry);
    }
  }

  /** Clears cached responses for one route path, or the entire cache. */
  clearCache(routePath?: string): void {
    if (routePath === undefined) {
      this.cache.clear();
      this.cacheUsage.clear();
      return;
    }
    for (const entry of [...this.cache.values()]) {
      if (entry.routePath === routePath) this.removeCacheEntry(entry);
    }
  }

  /**
   * Single-flight coordination: the first caller fills the cache, concurrent callers
   * wait for it (bounded by the caller) and then re-check before contacting upstream.
   */
  beginCacheFill(key: string): boolean {
    if (this.cacheFills.has(key)) return false;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.cacheFills.set(key, { promise, resolve });
    return true;
  }

  async awaitCacheFill(key: string, timeoutMs: number): Promise<void> {
    const fill = this.cacheFills.get(key);
    if (!fill) return;
    if (timeoutMs <= 0) return fill.promise;
    await Promise.race([
      fill.promise,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  }

  endCacheFill(key: string): void {
    const fill = this.cacheFills.get(key);
    if (!fill) return;
    this.cacheFills.delete(key);
    fill.resolve();
  }

  private removeCacheEntry(entry: CachedResponse): void {
    if (!this.cache.delete(entry.key)) return;
    const usage = this.cacheUsage.get(entry.routePath);
    if (!usage) return;
    usage.entries = Math.max(0, usage.entries - 1);
    usage.bytes = Math.max(0, usage.bytes - entry.size);
    if (usage.entries === 0) this.cacheUsage.delete(entry.routePath);
  }

  private evictCache(route: RouteState, maxEntries: number, maxBytes: number): void {
    const now = Date.now();
    for (const entry of [...this.cache.values()]) {
      if (entry.routePath === route.path && entry.expiresAt <= now) this.removeCacheEntry(entry);
    }
    let usage = this.cacheUsage.get(route.path);
    while (usage && (usage.entries > maxEntries || usage.bytes > maxBytes)) {
      let oldest: CachedResponse | undefined;
      for (const entry of this.cache.values()) {
        if (entry.routePath === route.path) {
          oldest = entry;
          break;
        }
      }
      if (!oldest) break;
      this.removeCacheEntry(oldest);
      usage = this.cacheUsage.get(route.path);
    }
  }

  private rateLimitIdentity(
    source: 'ip' | 'header',
    header: string | undefined,
    remoteAddress: string | undefined,
    headers: IncomingHttpHeaders,
  ): string {
    if (source === 'header' && header) {
      const raw = headers[header.toLowerCase()];
      const value = Array.isArray(raw) ? raw[0] : raw;
      if (typeof value === 'string' && value.trim()) return `h:${value.trim().slice(0, 256)}`;
    }
    const forwarded = headers['x-forwarded-for'];
    const forwardedAddress = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(',')[0]
      ?.trim();
    const address = (this.options.trustProxy && forwardedAddress) || remoteAddress || 'unknown';
    return `ip:${address}`;
  }

  tryReserveRetry(route: RouteState): boolean {
    const rate = route.config.retry?.maxRetryRate;
    if (rate === undefined) return true;
    const now = Date.now();
    const window = this.retryWindow.get(this.routeKey(route)) ?? { requests: [], retries: [] };
    this.pruneWindow(window.requests, now, RETRY_BUDGET_WINDOW_MS);
    this.pruneWindow(window.retries, now, RETRY_BUDGET_WINDOW_MS);
    this.capWindow(window.requests);
    this.capWindow(window.retries);
    const allowed = rate <= 0 ? 0 : Math.max(1, Math.floor(window.requests.length * rate));
    if (window.retries.length >= allowed) {
      this.retryWindow.set(this.routeKey(route), window);
      return false;
    }
    window.retries.push(now);
    this.retryWindow.set(this.routeKey(route), window);
    return true;
  }

  noteRetry(node: UpstreamState): void {
    node.retries += 1;
  }

  acquire(route: RouteState, excluded: ReadonlySet<string> = new Set(), request?: any, preferred?: string): UpstreamState | undefined {
    if (this.shuttingDown) return undefined;
    const now = Date.now();
    const bulk = route.config.bulkhead || {};
    const routeActive = route.upstreams.reduce((sum, node) => sum + node.active, 0);
    if (bulk.maxConcurrentPerRoute && routeActive >= bulk.maxConcurrentPerRoute) return undefined;

    const eligible = (node: UpstreamState): boolean => {
      if (node.drained) return false;
      if (excluded.has(node.url)) return false;
      if (node.ejectedUntil && node.ejectedUntil > now) return false;
      if (node.healthy) {
        if (bulk.maxConcurrentPerUpstream && node.active >= bulk.maxConcurrentPerUpstream) return false;
        return true;
      }
      if (node.blockedUntil > 0 && node.blockedUntil <= now && !node.probeInFlight) {
        const cb = route.config.circuitBreaker || {};
        const maxHalf = cb.maxHalfOpen === undefined ? 1 : cb.maxHalfOpen;
        if (maxHalf <= 0) return false;
        const count = this.halfOpenCount.get(this.routeKey(route)) || 0;
        if (count >= maxHalf) return false;
        if (bulk.maxConcurrentPerUpstream && node.active >= bulk.maxConcurrentPerUpstream) return false;
        return true;
      }
      return false;
    };

    const available = route.upstreams.filter(eligible);
    let node = preferred ? available.find(candidate => candidate.url === preferred && candidate.healthy) : undefined;
    if (!node) node = selectUpstream(route, available, request);
    if (!node) return undefined;

    if (!node.healthy) {
      node.probeInFlight = true;
      const key = this.routeKey(route);
      this.halfOpenCount.set(key, (this.halfOpenCount.get(key) || 0) + 1);
    }
    node.active += 1;
    node.requests += 1;
    this.noteRequest(route, node, now);
    return node;
  }

  private releaseProbe(route: RouteState, node: UpstreamState): void {
    const key = this.routeKey(route);
    this.halfOpenCount.set(key, Math.max(0, (this.halfOpenCount.get(key) || 0) - 1));
  }

  release(node: UpstreamState, route?: RouteState): void {
    const wasProbe = node.probeInFlight && !node.healthy;
    node.active = Math.max(0, node.active - 1);
    if (wasProbe) {
      const owner = route ?? this.routeFor(node);
      if (owner) this.releaseProbe(owner, node);
    }
    node.probeInFlight = false;
  }

  recordLatency(node: UpstreamState, durationMs: number): void {
    node.totalResponseTimeMs += durationMs;
    node.responseCount += 1;
    const alpha = 0.2;
    if (node.ewmaResponseTimeMs === 0) node.ewmaResponseTimeMs = durationMs;
    else node.ewmaResponseTimeMs = alpha * durationMs + (1 - alpha) * node.ewmaResponseTimeMs;
    node.ewmaObservedAt = Date.now();
  }

  success(node: UpstreamState, route?: RouteState): void {
    node.successes += 1;
    const owner = route ?? this.routeFor(node);
    if (owner) this.resetCircuit(owner, node);
  }

  failure(route: RouteState, node: UpstreamState): void {
    node.errors += 1;
    this.recordFailure(route, node);
  }

  observeStatus(route: RouteState, node: UpstreamState, statusCode: number): void {
    if (statusCode < 500 || statusCode > 599) {
      node.consecutive5xx = 0;
      return;
    }
    const now = Date.now();
    node.consecutive5xx += 1;
    node.lastFailureAt = now;
    const outlier = route.config.outlierDetection;
    if (!outlier?.consecutive5xx || node.consecutive5xx < outlier.consecutive5xx) return;
    const base = outlier.baseEjectionTimeMs ?? 30000;
    node.ejectedUntil = now + base * Math.max(1, node.ejectionCount + 1);
    node.ejectionCount += 1;
    node.lastEjectionAt = now;
    this.log.warn(`Upstream ejected after consecutive 5xx: ${node.url}`);
  }

  private resetCircuit(route: RouteState, node: UpstreamState): void {
    const wasUnhealthy = !node.healthy;
    const wasProbe = node.probeInFlight && wasUnhealthy;
    node.consecutiveFailures = 0;
    node.healthy = true;
    node.blockedUntil = 0;
    node.probeInFlight = false;
    if (wasProbe) this.releaseProbe(route, node);
    if (wasUnhealthy) {
      node.ejectedUntil = 0;
      node.ejectionCount = 0;
      const key = this.nodeKey(route, node);
      this.failureWindow.delete(key);
      this.requestWindow.delete(key);
    }
  }

  private recordFailure(route: RouteState, node: UpstreamState, countAsRequest = false): void {
    const now = Date.now();
    const wasProbe = node.probeInFlight && !node.healthy;
    node.consecutiveFailures += 1;
    node.probeInFlight = false;
    node.lastFailureAt = now;
    if (wasProbe) this.releaseProbe(route, node);

    const key = this.nodeKey(route, node);
    const failures = this.failureWindow.get(key) ?? [];
    failures.push(now);
    const cb = route.config.circuitBreaker || {};
    const windowMs = cb.slidingWindowSize ? cb.slidingWindowSize * 1000 : 60000;
    this.pruneWindow(failures, now, windowMs);
    this.capWindow(failures);
    this.failureWindow.set(key, failures);

    const requests = this.pruneWindow(this.requestWindow.get(key) ?? [], now, windowMs);
    if (countAsRequest) requests.push(now);
    this.capWindow(requests);
    this.requestWindow.set(key, requests);

    const minimumRequests = cb.minimumRequests ?? 1;
    const threshold = cb.failureThreshold ?? 1;
    const shouldOpen = cb.slidingWindowSize !== undefined
      ? failures.length >= threshold && requests.length >= minimumRequests
      : node.consecutiveFailures >= threshold;

    if (shouldOpen) {
      node.healthy = false;
      node.blockedUntil = now + (cb.cooldownMs ?? 10000);
      this.log.warn(`Upstream circuit open: ${node.url}`);
    }
  }

  metrics(): BalancerMetrics {
    return {
      routes: this.routes.map(route => ({
        path: route.path,
        rateLimited: route.rateLimited,
        cacheHits: route.cacheHits,
        cacheMisses: route.cacheMisses,
        cacheStores: route.cacheStores,
        upstreams: route.upstreams.map(node => ({ ...node })),
      })),
    };
  }

  async onModuleInit(): Promise<void> {
    await Promise.all(this.routes.filter(route => route.config.healthCheck).map(route => this.checkRoute(route)));
    this.restartTimers();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.shuttingDown = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    // Active probes stop immediately; in-flight client requests get the drain window.
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();

    const deadline = Date.now() + this.shutdownTimeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    for (const controller of this.inFlight) controller.abort();
    this.inFlight.clear();
    this.rateLimits.clear();
    this.clearCache();
    for (const key of [...this.cacheFills.keys()]) this.endCacheFill(key);
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  private maintainOutliers(route: RouteState, intervalMs: number): void {
    const now = Date.now();
    const windowMs = route.config.circuitBreaker?.slidingWindowSize
      ? route.config.circuitBreaker.slidingWindowSize * 1000
      : 60000;
    for (const node of route.upstreams) {
      if (node.ejectedUntil > 0 && node.ejectedUntil <= now) node.ejectedUntil = 0;
      if (node.ejectionCount > 0 && node.lastFailureAt > 0 && now - node.lastFailureAt >= intervalMs) {
        node.ejectionCount = Math.max(0, node.ejectionCount - 1);
        node.lastFailureAt = now;
      }
      const key = this.nodeKey(route, node);
      this.failureWindow.set(key, this.pruneWindow(this.failureWindow.get(key) ?? [], now, windowMs));
      this.requestWindow.set(key, this.pruneWindow(this.requestWindow.get(key) ?? [], now, windowMs));
    }
  }

  private async checkRoute(route: RouteState): Promise<void> {
    await Promise.all(route.upstreams.map(node => this.checkOne(route, node)));
  }

  private async checkOne(route: RouteState, node: UpstreamState): Promise<void> {
    const health = route.config.healthCheck;
    if (!health) return;
    const key = `${route.path}:${node.url}`;
    if (this.healthChecksInFlight.has(key)) return;
    this.healthChecksInFlight.add(key);
    const url = new URL(health.path, node.url);
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), health.timeoutMs ?? 2000);
    try {
      const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const status = await new Promise<number>((resolve, reject) => {
        const request = transport(url, {
          method: (health.method ?? 'GET').toUpperCase(),
          headers: health.headers,
          signal: controller.signal,
          agent: url.protocol === 'https:' ? this.httpsAgent : this.httpAgent,
        }, res => { res.resume(); resolve(res.statusCode ?? 0); });
        request.once('error', reject);
        request.end();
      });
      if (health.expectedStatus ? health.expectedStatus.includes(status) : status >= 200 && status < 400) {
        node.healthCheckSuccesses += 1;
        node.consecutive5xx = 0;
        this.resetCircuit(route, node);
      } else {
        node.healthCheckFailures += 1;
        this.recordFailure(route, node, true);
      }
    } catch {
      node.healthCheckFailures += 1;
      this.recordFailure(route, node, true);
    }
    finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
      this.healthChecksInFlight.delete(key);
    }
  }
}
