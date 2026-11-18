import { RouteBalancerOptions, RouteState } from './types';
import { validateUpstreamOrigin } from './utils/ssrf';

export const ROUTE_BALANCER_OPTIONS = Symbol('ROUTE_BALANCER_OPTIONS');
export const ROUTE_BALANCER_PLUGINS = Symbol('ROUTE_BALANCER_PLUGINS');

const FORBIDDEN_PLUGIN_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'proxy-connection', 'host', 'content-length', 'expect',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-request-id',
]);
const HEADER_NAME_PATTERN = /^[-!#$%&'*+.^_`|~0-9A-Za-z]+$/;

function validateRequestInterception(options: any): void {
  if (options === undefined) return;
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid requestInterception');
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30000)) {
    throw new Error('requestInterception.timeoutMs must be an integer between 1 and 30000');
  }
  for (const field of ['allowedHeaders', 'exposedHeaders']) {
    if (options[field] !== undefined && (!Array.isArray(options[field]) || options[field].some((name: any) =>
      typeof name !== 'string' || name.length > 256 || !HEADER_NAME_PATTERN.test(name)
      || FORBIDDEN_PLUGIN_HEADERS.has(name.toLowerCase())
    ))) throw new Error(`Invalid requestInterception.${field}`);
  }
}

function isHealthCheckPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.includes('#') || /[\r\n]/.test(value)) return false;
  try {
    const base = new URL('http://health-check.invalid');
    const parsed = new URL(value, base);
    return parsed.origin === base.origin;
  } catch {
    return false;
  }
}

function parseUpstreamOrigin(value: string, ssrf?: RouteBalancerOptions['ssrf']): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid upstream URL: ${value}`);
  }
  if (url.username || url.password) throw new Error(`Credentials not allowed in upstream URL: ${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Upstream must be an HTTP(S) origin: ${value}`);
  }
  const check = validateUpstreamOrigin(url.origin, ssrf || {});
  if (!check.valid) throw new Error(check.reason || `Upstream blocked by SSRF policy: ${value}`);
  return url.origin;
}

function validateTimeouts(timeouts: any): void {
  if (timeouts === undefined) return;
  if (typeof timeouts !== 'object' || timeouts === null) throw new Error('Invalid timeouts');
  const fields = ['connectTimeoutMs', 'headersTimeoutMs', 'requestTimeoutMs', 'idleTimeoutMs'];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const v = timeouts[f];
    if (v !== undefined && (!Number.isFinite(v) || v < 0)) throw new Error(`Invalid ${f}`);
  }
}

function validateBulkhead(bulkhead: any): void {
  if (bulkhead === undefined) return;
  if (typeof bulkhead !== 'object' || bulkhead === null) throw new Error('Invalid bulkhead');
  if (bulkhead.maxConcurrentPerUpstream !== undefined && (!Number.isSafeInteger(bulkhead.maxConcurrentPerUpstream) || bulkhead.maxConcurrentPerUpstream < 1)) throw new Error('Invalid maxConcurrentPerUpstream');
  if (bulkhead.maxConcurrentPerRoute !== undefined && (!Number.isSafeInteger(bulkhead.maxConcurrentPerRoute) || bulkhead.maxConcurrentPerRoute < 1)) throw new Error('Invalid maxConcurrentPerRoute');
}

function validateRateLimit(rateLimit: any): void {
  if (rateLimit === undefined) return;
  if (!rateLimit || typeof rateLimit !== 'object' || Array.isArray(rateLimit)) throw new Error('Invalid rateLimit');
  if (!Number.isSafeInteger(rateLimit.limit) || rateLimit.limit < 1) throw new Error('rateLimit.limit must be a positive integer');
  if (!Number.isFinite(rateLimit.windowMs) || rateLimit.windowMs < 10) throw new Error('rateLimit.windowMs must be at least 10');
  if (rateLimit.key !== undefined && rateLimit.key !== 'ip' && rateLimit.key !== 'header') throw new Error('Invalid rateLimit.key');
  if (rateLimit.key === 'header' && (typeof rateLimit.header !== 'string' || rateLimit.header.length > 256 || !HEADER_NAME_PATTERN.test(rateLimit.header))) {
    throw new Error('rateLimit.header is required when key is "header"');
  }
  if (rateLimit.header !== undefined && (typeof rateLimit.header !== 'string' || rateLimit.header.length > 256 || !HEADER_NAME_PATTERN.test(rateLimit.header))) {
    throw new Error('Invalid rateLimit.header');
  }
  if (rateLimit.perRoute !== undefined && typeof rateLimit.perRoute !== 'boolean') throw new Error('Invalid rateLimit.perRoute');
  if (rateLimit.maxKeys !== undefined && (!Number.isSafeInteger(rateLimit.maxKeys) || rateLimit.maxKeys < 1 || rateLimit.maxKeys > 1_000_000)) {
    throw new Error('Invalid rateLimit.maxKeys');
  }
}

function validateCache(cache: any): void {
  if (cache === undefined) return;
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) throw new Error('Invalid cache');
  if (!Number.isFinite(cache.ttlMs) || cache.ttlMs <= 0) throw new Error('cache.ttlMs must be a positive number');
  if (cache.statuses !== undefined && (!Array.isArray(cache.statuses) || cache.statuses.length === 0
    || cache.statuses.some((status: any) => !Number.isInteger(status) || status < 100 || status > 599))) {
    throw new Error('Invalid cache.statuses');
  }
  if (cache.vary !== undefined && (!Array.isArray(cache.vary) || cache.vary.some((name: any) =>
    typeof name !== 'string' || name.length > 256 || name === '*' || !HEADER_NAME_PATTERN.test(name)))) {
    throw new Error('Invalid cache.vary');
  }
  if (cache.maxEntries !== undefined && (!Number.isSafeInteger(cache.maxEntries) || cache.maxEntries < 1 || cache.maxEntries > 1_000_000)) {
    throw new Error('Invalid cache.maxEntries');
  }
  if (cache.maxBytes !== undefined && (!Number.isSafeInteger(cache.maxBytes) || cache.maxBytes < 1)) throw new Error('Invalid cache.maxBytes');
  if (cache.maxEntryBytes !== undefined && (!Number.isSafeInteger(cache.maxEntryBytes) || cache.maxEntryBytes < 1)) throw new Error('Invalid cache.maxEntryBytes');
}

function validateOutlier(outlier: any): void {
  if (outlier === undefined) return;
  if (typeof outlier !== 'object' || outlier === null) throw new Error('Invalid outlierDetection');
  if (outlier.consecutive5xx !== undefined && (!Number.isSafeInteger(outlier.consecutive5xx) || outlier.consecutive5xx < 1)) throw new Error('Invalid consecutive5xx');
  if (outlier.intervalMs !== undefined && (!Number.isFinite(outlier.intervalMs) || outlier.intervalMs < 100)) throw new Error('Invalid outlier intervalMs');
  if (outlier.baseEjectionTimeMs !== undefined && (!Number.isFinite(outlier.baseEjectionTimeMs) || outlier.baseEjectionTimeMs < 1000)) throw new Error('Invalid baseEjectionTimeMs');
}

function validateSticky(sticky: any): void {
  if (sticky === undefined) return;
  if (typeof sticky !== 'object' || sticky === null) throw new Error('Invalid sticky');
  if (sticky.cookie !== undefined && (typeof sticky.cookie !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(sticky.cookie))) throw new Error('Invalid sticky cookie');
  if (sticky.ttlMs !== undefined && (!Number.isFinite(sticky.ttlMs) || sticky.ttlMs < 0)) throw new Error('Invalid sticky ttlMs');
  if (sticky.sameSite !== undefined) {
    const sameSite = String(sticky.sameSite).toLowerCase();
    if (sameSite !== 'strict' && sameSite !== 'lax' && sameSite !== 'none') throw new Error('Invalid sticky sameSite');
  }
  if (sticky.secure !== undefined && typeof sticky.secure !== 'boolean') throw new Error('Invalid sticky secure');
  if (sticky.httpOnly !== undefined && typeof sticky.httpOnly !== 'boolean') throw new Error('Invalid sticky httpOnly');
  if (sticky.secret !== undefined && (typeof sticky.secret !== 'string' || !sticky.secret.trim())) throw new Error('Invalid sticky secret');
}

function validateSsrf(ssrf: any): void {
  if (ssrf === undefined) return;
  if (typeof ssrf !== 'object' || ssrf === null) throw new Error('Invalid ssrf');
  for (const field of ['allowPrivate', 'allowLocalhost', 'allowLinkLocal', 'allowlinkLocal']) {
    if (ssrf[field] !== undefined && typeof ssrf[field] !== 'boolean') throw new Error(`Invalid ssrf ${field}`);
  }
  for (const field of ['allowlist', 'blocklist']) {
    if (ssrf[field] !== undefined && (!Array.isArray(ssrf[field]) || ssrf[field].some((value: any) => typeof value !== 'string' || !value))) {
      throw new Error(`Invalid ssrf ${field}`);
    }
  }
}

function validateHealthHeaders(headers: any): void {
  if (headers === undefined) return;
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) throw new Error('Invalid healthCheck headers');
  for (const [name, value] of Object.entries(headers)) {
    if (name.length > 256 || !HEADER_NAME_PATTERN.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('Invalid healthCheck headers');
  }
}

export function validateOptions(options: RouteBalancerOptions): RouteState[] {
  if (!options || !Array.isArray(options.routes)) throw new Error('routes must be an array');
  if (options.maxSockets !== undefined && (!Number.isSafeInteger(options.maxSockets) || options.maxSockets < 1)) throw new Error('maxSockets must be a positive integer');
  if (options.keepAlive !== undefined && typeof options.keepAlive !== 'boolean') throw new Error('keepAlive must be a boolean');
  if (options.trustProxy !== undefined && typeof options.trustProxy !== 'boolean') throw new Error('trustProxy must be a boolean');
  if (options.shutdownTimeoutMs !== undefined && (!Number.isFinite(options.shutdownTimeoutMs) || options.shutdownTimeoutMs <= 0)) throw new Error('shutdownTimeoutMs must be a positive number');
  validateRequestInterception(options.requestInterception);
  validateSsrf(options.ssrf);
  const paths = new Set<string>();
  return options.routes.map((config) => {
    if (typeof config.path !== 'string' || !config.path.startsWith('/') || config.path.includes('?') || config.path.includes('#') || config.path.includes('\\') || /[\u0000-\u001f\u007f]/.test(config.path)) throw new Error(`Invalid route path: ${config.path}`);
    const path = config.path.length > 1 ? config.path.replace(/\/+$/, '') : '/';
    if (paths.has(path)) throw new Error(`Duplicate route path: ${path}`);
    paths.add(path);
    if (!Array.isArray(config.upstreams) || config.upstreams.length === 0) throw new Error(`No upstreams for ${path}`);
    if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) throw new Error(`Invalid timeout for ${path}`);
    if (config.stripPrefix !== undefined && typeof config.stripPrefix !== 'boolean') throw new Error(`stripPrefix must be a boolean for ${path}`);
    if (config.changeOrigin !== undefined && typeof config.changeOrigin !== 'boolean') throw new Error(`changeOrigin must be a boolean for ${path}`);
    if (config.hashKey !== undefined && typeof config.hashKey !== 'string') throw new Error(`Invalid hashKey for ${path}`);
    if (config.hashHeader !== undefined && (typeof config.hashHeader !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(config.hashHeader))) throw new Error(`Invalid hashHeader for ${path}`);
    if (config.hashKey === 'header' && config.hashHeader === undefined) throw new Error(`hashHeader is required when hashKey is 'header' for ${path}`);
    validateTimeouts((config as any).timeouts);
    validateBulkhead((config as any).bulkhead);
    validateRateLimit((config as any).rateLimit);
    validateCache((config as any).cache);
    validateOutlier((config as any).outlierDetection);
    validateSticky((config as any).sticky);
    if ((config as any).allowedHosts !== undefined && (!Array.isArray((config as any).allowedHosts) || (config as any).allowedHosts.some((h: any) => typeof h !== 'string' || !h.trim()))) throw new Error(`Invalid allowedHosts for ${path}`);
    const hc: any = config.healthCheck;
    if (hc) {
      if (typeof hc.path !== 'string' || !isHealthCheckPath(hc.path) || !Number.isFinite(hc.intervalMs) || hc.intervalMs < 100) throw new Error(`Invalid healthCheck for ${path}`);
      if (hc.timeoutMs !== undefined && (!Number.isFinite(hc.timeoutMs) || hc.timeoutMs <= 0)) throw new Error(`Invalid healthCheck for ${path}`);
      if (hc.expectedStatus !== undefined && (!Array.isArray(hc.expectedStatus) || hc.expectedStatus.length === 0 || hc.expectedStatus.some((s: any) => !Number.isInteger(s) || s < 100 || s > 599))) throw new Error(`Invalid healthCheck for ${path}`);
      if (hc.method !== undefined && (typeof hc.method !== 'string' || !/^[A-Z]+$/.test(hc.method.toUpperCase()) || hc.method.toUpperCase() === 'CONNECT')) throw new Error(`Invalid healthCheck for ${path}`);
      validateHealthHeaders(hc.headers);
    }
    const retry: any = config.retry;
    if (retry) {
      if (retry.attempts !== undefined && (!Number.isSafeInteger(retry.attempts) || retry.attempts < 0 || retry.attempts > 10)) throw new Error(`Invalid retry policy for ${path}`);
      if (retry.backoffMs !== undefined && (!Number.isFinite(retry.backoffMs) || retry.backoffMs < 0)) throw new Error(`Invalid retry policy for ${path}`);
      if (retry.jitterMs !== undefined && (!Number.isFinite(retry.jitterMs) || retry.jitterMs < 0)) throw new Error(`Invalid retry policy for ${path}`);
      if (retry.maxBackoffMs !== undefined && (!Number.isFinite(retry.maxBackoffMs) || retry.maxBackoffMs < 0)) throw new Error(`Invalid retry policy for ${path}`);
      if (retry.maxRetryRate !== undefined && (!Number.isFinite(retry.maxRetryRate) || retry.maxRetryRate < 0 || retry.maxRetryRate > 1)) throw new Error(`Invalid retry policy for ${path}`);
      if (retry.methods !== undefined && (!Array.isArray(retry.methods) || retry.methods.some((m: any) => typeof m !== 'string' || (m.toUpperCase() !== 'GET' && m.toUpperCase() !== 'HEAD')))) throw new Error(`Invalid retry policy for ${path}`);
      if (retry.retryOn !== undefined && (!Array.isArray(retry.retryOn) || retry.retryOn.some((r: any) => r !== 'network' && r !== 'timeout' && r !== 'connect'))) throw new Error(`Invalid retry policy for ${path}`);
    }
    const cb: any = config.circuitBreaker;
    if (cb) {
      if (cb.failureThreshold !== undefined && (!Number.isSafeInteger(cb.failureThreshold) || cb.failureThreshold < 1)) throw new Error(`Invalid circuit breaker for ${path}`);
      if (cb.cooldownMs !== undefined && (!Number.isFinite(cb.cooldownMs) || cb.cooldownMs < 100)) throw new Error(`Invalid circuit breaker for ${path}`);
      if (cb.slidingWindowSize !== undefined && (!Number.isSafeInteger(cb.slidingWindowSize) || cb.slidingWindowSize < 1)) throw new Error(`Invalid circuit breaker for ${path}`);
      if (cb.minimumRequests !== undefined && (!Number.isSafeInteger(cb.minimumRequests) || cb.minimumRequests < 1)) throw new Error(`Invalid circuit breaker for ${path}`);
      if (cb.maxHalfOpen !== undefined && (!Number.isSafeInteger(cb.maxHalfOpen) || cb.maxHalfOpen < 0)) throw new Error(`Invalid circuit breaker for ${path}`);
    }
    const upstreams = config.upstreams.map((entry: any) => {
      const item = typeof entry === 'string' ? { url: entry, weight: 1 } : { url: entry.url, weight: entry.weight === undefined ? 1 : entry.weight };
      if (!item || typeof item.url !== 'string') throw new Error('Upstream URL must be a string');
      if (!Number.isSafeInteger(item.weight) || item.weight < 1 || item.weight > 1000) throw new Error(`Invalid weight: ${item.weight}`);
      const origin = parseUpstreamOrigin(item.url, options.ssrf);
      return {
        url: origin,
        weight: item.weight,
        healthy: true,
        drained: false,
        active: 0,
        requests: 0,
        errors: 0,
        successes: 0,
        retries: 0,
        healthCheckSuccesses: 0,
        healthCheckFailures: 0,
        consecutiveFailures: 0,
        consecutive5xx: 0,
        blockedUntil: 0,
        probeInFlight: false,
        currentWeight: 0,
        totalResponseTimeMs: 0,
        responseCount: 0,
        ewmaResponseTimeMs: 0,
        ewmaObservedAt: 0,
        ejectedUntil: 0,
        ejectionCount: 0,
        lastFailureAt: 0,
        lastEjectionAt: 0,
      };
    });
    return {
      path,
      config,
      upstreams,
      cursor: 0,
      weightedCursor: 0,
      rateLimited: 0,
      cacheHits: 0,
      cacheMisses: 0,
      cacheStores: 0,
    };
  });
}

export function routeMatches(prefix: string, pathname: string): boolean {
  return prefix === '/' || pathname === prefix || pathname.startsWith(prefix + '/');
}
