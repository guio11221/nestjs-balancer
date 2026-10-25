import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { ROUTE_BALANCER_OPTIONS, routeMatches, validateOptions } from './options';
import { BalancerMetrics, RouteBalancerOptions, RouteState, UpstreamState } from './types';
import { hasStrategy, selectUpstream } from './strategies/select';

@Injectable()
export class RouteBalancerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(RouteBalancerService.name);
  private readonly routes: RouteState[];
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly controllers = new Set<AbortController>();
  private readonly healthChecksInFlight = new Set<string>();
  private readonly halfOpenCount = new Map<string, number>();
  private readonly failureWindow = new Map<string, number[]>();
  readonly httpAgent: HttpAgent;
  readonly httpsAgent: HttpsAgent;

  constructor(@Inject(ROUTE_BALANCER_OPTIONS) readonly options: RouteBalancerOptions) {
    this.routes = validateOptions(options).sort((a, b) => b.path.length - a.path.length);
    for (const route of this.routes) if (!hasStrategy(route.config.strategy ?? 'round-robin')) throw new Error(`Unknown strategy: ${route.config.strategy}`);
    const agentOptions = { keepAlive: options.keepAlive ?? true, maxSockets: options.maxSockets ?? 128 };
    this.httpAgent = new HttpAgent(agentOptions);
    this.httpsAgent = new HttpsAgent(agentOptions);
  }
  findRoute(pathname: string): RouteState | undefined {
    return this.routes.find(route => routeMatches(route.path, pathname));
  }
  private routeKey(route: RouteState): string {
    return route.path;
  }
  private nodeKey(route: RouteState, node: UpstreamState): string {
    return `${route.path}:${node.url}`;
  }
  acquire(route: RouteState, excluded: ReadonlySet<string> = new Set(), request?: any): UpstreamState | undefined {
    const now = Date.now();
    const bulk = route.config.bulkhead || {};
    const routeActive = route.upstreams.reduce((s, n) => s + n.active, 0);
    if (bulk.maxConcurrentPerRoute && routeActive >= bulk.maxConcurrentPerRoute) return undefined;
    const available = route.upstreams.filter(node => {
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
        const cnt = this.halfOpenCount.get(this.routeKey(route)) || 0;
        if (cnt >= maxHalf) return false;
        if (bulk.maxConcurrentPerUpstream && node.active >= bulk.maxConcurrentPerUpstream) return false;
        return true;
      }
      return false;
    });
    const node = selectUpstream(route, available, request);
    if (node) {
      if (!node.healthy) {
        node.probeInFlight = true;
        const k = this.routeKey(route);
        this.halfOpenCount.set(k, (this.halfOpenCount.get(k) || 0) + 1);
      }
      node.active++;
      node.requests++;
    }
    return node;
  }
  private releaseProbe(node: UpstreamState): void {
    for (const route of this.routes) {
      if (route.upstreams.includes(node)) {
        const rk = this.routeKey(route);
        this.halfOpenCount.set(rk, Math.max(0, (this.halfOpenCount.get(rk) || 0) - 1));
        break;
      }
    }
  }
  release(node: UpstreamState): void {
    const wasProbe = node.probeInFlight && !node.healthy;
    node.active = Math.max(0, node.active - 1);
    if (wasProbe) {
      this.releaseProbe(node);
    }
    node.probeInFlight = false;
  }
  recordLatency(node: UpstreamState, durationMs: number): void {
    node.totalResponseTimeMs += durationMs;
    node.responseCount += 1;
    const alpha = 0.2;
    if (node.ewmaResponseTimeMs === 0) node.ewmaResponseTimeMs = durationMs;
    else node.ewmaResponseTimeMs = alpha * durationMs + (1 - alpha) * node.ewmaResponseTimeMs;
  }
  success(node: UpstreamState): void {
    node.successes++;
    this.resetCircuit(node);
  }
  failure(route: RouteState, node: UpstreamState): void {
    node.errors++;
    this.recordFailure(route, node);
  }
  private resetCircuit(node: UpstreamState): void {
    const wasProbe = node.probeInFlight && !node.healthy;
    node.consecutiveFailures = 0;
    node.healthy = true;
    node.blockedUntil = 0;
    node.probeInFlight = false;
    node.ejectedUntil = 0;
    if (wasProbe) {
      this.releaseProbe(node);
    }
  }
  private recordFailure(route: RouteState, node: UpstreamState): void {
    const wasProbe = node.probeInFlight && !node.healthy;
    node.consecutiveFailures++;
    node.probeInFlight = false;
    if (wasProbe) {
      const rk = this.routeKey(route);
      this.halfOpenCount.set(rk, Math.max(0, (this.halfOpenCount.get(rk) || 0) - 1));
    }
    const k = this.nodeKey(route, node);
    const win = this.failureWindow.get(k) || [];
    win.push(Date.now());
    const cb = route.config.circuitBreaker || {};
    const windowMs = cb.slidingWindowSize ? cb.slidingWindowSize * 1000 : 60000;
    const filtered = win.filter(ts => Date.now() - ts < windowMs);
    this.failureWindow.set(k, filtered);
    const minReq = cb.minimumRequests ?? 1;
    const threshold = cb.failureThreshold ?? 1;
    const shouldOpen = cb.slidingWindowSize !== undefined ? filtered.length >= threshold && node.requests >= minReq : node.consecutiveFailures >= threshold;
    if (shouldOpen) {
      node.healthy = false;
      node.blockedUntil = Date.now() + (cb.cooldownMs ?? 10000);
      this.log.warn(`Upstream circuit open: ${node.url}`);
    }
    // outlier detection
    const outlier = route.config.outlierDetection || {};
    if (outlier.consecutive5xx && node.consecutiveFailures >= outlier.consecutive5xx) {
      const base = outlier.baseEjectionTimeMs ?? 30000;
      node.ejectedUntil = Date.now() + base * Math.max(1, node.ejectionCount + 1);
      node.ejectionCount += 1;
      this.log.warn(`Upstream ejected (outlier): ${node.url}`);
    }
  }
  metrics(): BalancerMetrics {
    return { routes: this.routes.map(route => ({ path: route.path, upstreams: route.upstreams.map(node => ({ ...node })) })) };
  }
  async onModuleInit(): Promise<void> {
    await Promise.all(this.routes.filter(route => route.config.healthCheck).map(route => this.checkRoute(route)));
    for (const route of this.routes) {
      const intervalMs = route.config.healthCheck?.intervalMs;
      if (!intervalMs) continue;
      const timer = setInterval(() => { void this.checkRoute(route); }, intervalMs);
      timer.unref();
      this.timers.push(timer);
    }
  }
  onModuleDestroy(): void {
    for (const timer of this.timers) clearInterval(timer);
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
  private async checkRoute(route: RouteState): Promise<void> {
    await Promise.all(route.upstreams.map(node => this.checkOne(route, node)));
  }
  private async checkOne(route: RouteState, node: UpstreamState): Promise<void> {
    const health = route.config.healthCheck!;
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
        const request = transport(url, { method: 'GET', signal: controller.signal, agent: false }, res => { res.resume(); resolve(res.statusCode ?? 0); });
        request.once('error', reject);
        request.end();
      });
      if (health.expectedStatus ? health.expectedStatus.includes(status) : status >= 200 && status < 400) {
        node.healthCheckSuccesses++;
        this.resetCircuit(node);
      } else {
        node.healthCheckFailures++;
        this.recordFailure(route, node);
      }
    } catch {
      node.healthCheckFailures++;
      this.recordFailure(route, node);
    }
    finally { clearTimeout(timer); this.controllers.delete(controller); this.healthChecksInFlight.delete(key); }
  }
}
