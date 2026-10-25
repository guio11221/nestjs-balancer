import type { IncomingMessage, ServerResponse } from 'node:http';

export type BalancingStrategy = 'round-robin' | 'weighted-round-robin' | 'least-connections' | 'random' | 'least-response-time' | 'consistent-hash' | (string & {});
export interface UpstreamOptions { url: string; weight?: number; }
export interface HealthCheckOptions { path: string; intervalMs: number; timeoutMs?: number; expectedStatus?: number[]; }
export interface RetryOptions { attempts?: number; methods?: string[]; backoffMs?: number; jitterMs?: number; maxRetryRate?: number; retryOn?: Array<'network' | 'timeout' | 'connect'>; }
export interface CircuitBreakerOptions { failureThreshold?: number; cooldownMs?: number; slidingWindowSize?: number; minimumRequests?: number; maxHalfOpen?: number; }
export interface BulkheadOptions { maxConcurrentPerUpstream?: number; maxConcurrentPerRoute?: number; }
export interface OutlierDetectionOptions { consecutive5xx?: number; intervalMs?: number; baseEjectionTimeMs?: number; }
export interface SsrfOptions { allowPrivate?: boolean; allowLocalhost?: boolean; allowlinkLocal?: boolean; allowlist?: string[]; blocklist?: string[]; }
export interface StickyOptions { cookie?: string; ttlMs?: number; secure?: boolean; httpOnly?: boolean; sameSite?: 'strict' | 'lax' | 'none'; }
export interface TimeoutsOptions { connectTimeoutMs?: number; headersTimeoutMs?: number; requestTimeoutMs?: number; idleTimeoutMs?: number; }
export interface RouteOptions {
  path: string;
  upstreams: Array<string | UpstreamOptions>;
  strategy?: BalancingStrategy;
  healthCheck?: HealthCheckOptions;
  timeoutMs?: number;
  timeouts?: TimeoutsOptions;
  stripPrefix?: boolean;
  changeOrigin?: boolean;
  retry?: RetryOptions;
  circuitBreaker?: CircuitBreakerOptions;
  bulkhead?: BulkheadOptions;
  outlierDetection?: OutlierDetectionOptions;
  sticky?: StickyOptions;
  allowedHosts?: string[];
  hashKey?: 'ip' | 'path' | 'header' | string;
  hashHeader?: string;
}
export interface RouteBalancerOptions {
  routes: RouteOptions[];
  trustProxy?: boolean;
  maxSockets?: number;
  keepAlive?: boolean;
  ssrf?: SsrfOptions;
}
export interface RouteBalancerAsyncOptions {
  imports?: any[];
  inject?: any[];
  useFactory: (...args: any[]) => Promise<RouteBalancerOptions> | RouteBalancerOptions;
}
export interface UpstreamState {
  url: string;
  weight: number;
  healthy: boolean;
  active: number;
  requests: number;
  errors: number;
  successes: number;
  healthCheckSuccesses: number;
  healthCheckFailures: number;
  consecutiveFailures: number;
  blockedUntil: number;
  probeInFlight: boolean;
  currentWeight: number;
  totalResponseTimeMs: number;
  responseCount: number;
  ewmaResponseTimeMs: number;
  ejectedUntil: number;
  ejectionCount: number;
}
export interface RouteState { path: string; config: RouteOptions; upstreams: UpstreamState[]; cursor: number; weightedCursor: number; }
export interface BalancerMetrics { routes: Array<{path: string; upstreams: UpstreamState[]}>; }
export interface ProxyRequest extends IncomingMessage { originalUrl?: string; }
export type ProxyResponse = ServerResponse;
export interface BalancerStrategy { name: string; select(route: RouteState, available: UpstreamState[]): UpstreamState | undefined; }
