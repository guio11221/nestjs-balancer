import { RouteBalancerOptions, RouteState } from './types';
import { validateUpstreamOrigin } from './utils/ssrf';

export const ROUTE_BALANCER_OPTIONS = Symbol('ROUTE_BALANCER_OPTIONS');

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
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
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
  if (sticky.cookie !== undefined && typeof sticky.cookie !== 'string') throw new Error('Invalid sticky cookie');
  if (sticky.ttlMs !== undefined && (!Number.isFinite(sticky.ttlMs) || sticky.ttlMs < 0)) throw new Error('Invalid sticky ttlMs');
  if (sticky.sameSite !== undefined && sticky.sameSite !== 'strict' && sticky.sameSite !== 'lax' && sticky.sameSite !== 'none') throw new Error('Invalid sticky sameSite');
  if (sticky.secure !== undefined && typeof sticky.secure !== 'boolean') throw new Error('Invalid sticky secure');
  if (sticky.httpOnly !== undefined && typeof sticky.httpOnly !== 'boolean') throw new Error('Invalid sticky httpOnly');
}

export function validateOptions(options: RouteBalancerOptions): RouteState[] {
  if (!options || !Array.isArray(options.routes)) throw new Error('routes must be an array');
  if (options.maxSockets !== undefined && (!Number.isSafeInteger(options.maxSockets) || options.maxSockets < 1)) throw new Error('maxSockets must be a positive integer');
  if (options.keepAlive !== undefined && typeof options.keepAlive !== 'boolean') throw new Error('keepAlive must be a boolean');
  if (options.trustProxy !== undefined && typeof options.trustProxy !== 'boolean') throw new Error('trustProxy must be a boolean');
  const paths = new Set<string>();
  return options.routes.map((config) => {
    if (typeof config.path !== 'string' || !config.path.startsWith('/') || config.path.includes('?') || config.path.includes('#') || config.path.includes('\\')) throw new Error(`Invalid route path: ${config.path}`);
    const path = config.path.length > 1 ? config.path.replace(/\/+$/, '') : '/';
    if (paths.has(path)) throw new Error(`Duplicate route path: ${path}`);
    paths.add(path);
    if (!Array.isArray(config.upstreams) || config.upstreams.length === 0) throw new Error(`No upstreams for ${path}`);
    if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) throw new Error(`Invalid timeout for ${path}`);
    if (config.stripPrefix !== undefined && typeof config.stripPrefix !== 'boolean') throw new Error(`stripPrefix must be a boolean for ${path}`);
    if (config.changeOrigin !== undefined && typeof config.changeOrigin !== 'boolean') throw new Error(`changeOrigin must be a boolean for ${path}`);
    validateTimeouts((config as any).timeouts);
    validateBulkhead((config as any).bulkhead);
    validateOutlier((config as any).outlierDetection);
    validateSticky((config as any).sticky);
    if ((config as any).allowedHosts !== undefined && (!Array.isArray((config as any).allowedHosts) || (config as any).allowedHosts.some((h: any) => typeof h !== 'string'))) throw new Error(`Invalid allowedHosts for ${path}`);
    const hc: any = config.healthCheck;
    if (hc) {
      if (typeof hc.path !== 'string' || !isHealthCheckPath(hc.path) || !Number.isFinite(hc.intervalMs) || hc.intervalMs < 100) throw new Error(`Invalid healthCheck for ${path}`);
      if (hc.timeoutMs !== undefined && (!Number.isFinite(hc.timeoutMs) || hc.timeoutMs <= 0)) throw new Error(`Invalid healthCheck for ${path}`);
      if (hc.expectedStatus !== undefined && (!Array.isArray(hc.expectedStatus) || hc.expectedStatus.length === 0 || hc.expectedStatus.some((s: any) => !Number.isInteger(s) || s < 100 || s > 599))) throw new Error(`Invalid healthCheck for ${path}`);
    }
    const retry: any = config.retry;
    if (retry) {
      if (retry.attempts !== undefined && (!Number.isSafeInteger(retry.attempts) || retry.attempts < 0 || retry.attempts > 10)) throw new Error(`Invalid retry policy for ${path}`);
      if (retry.backoffMs !== undefined && (!Number.isFinite(retry.backoffMs) || retry.backoffMs < 0)) throw new Error(`Invalid retry policy for ${path}`);
      if (retry.jitterMs !== undefined && (!Number.isFinite(retry.jitterMs) || retry.jitterMs < 0)) throw new Error(`Invalid retry policy for ${path}`);
      if (retry.maxRetryRate !== undefined && (!Number.isFinite(retry.maxRetryRate) || retry.maxRetryRate < 0 || retry.maxRetryRate > 1)) throw new Error(`Invalid retry policy for ${path}`);
      if (retry.methods !== undefined && (!Array.isArray(retry.methods) || retry.methods.some((m: any) => typeof m !== 'string' || (m.toUpperCase() !== 'GET' && m.toUpperCase() !== 'HEAD')))) throw new Error(`Invalid retry policy for ${path}`);
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
      return { url: origin, weight: item.weight, healthy: true, active: 0, requests: 0, errors: 0, successes: 0, healthCheckSuccesses: 0, healthCheckFailures: 0, consecutiveFailures: 0, blockedUntil: 0, probeInFlight: false, currentWeight: 0, totalResponseTimeMs: 0, responseCount: 0, ewmaResponseTimeMs: 0, ejectedUntil: 0, ejectionCount: 0 };
    });
    return { path, config: config as any, upstreams, cursor: 0, weightedCursor: 0 } as RouteState;
  });
}

export function routeMatches(prefix: string, pathname: string): boolean {
  return prefix === '/' || pathname === prefix || pathname.startsWith(prefix + '/');
}
