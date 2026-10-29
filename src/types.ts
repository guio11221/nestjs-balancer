import type { InjectionToken, Provider } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type BalancingStrategy = 'round-robin' | 'weighted-round-robin' | 'least-connections' | 'random' | 'least-response-time' | 'peak-ewma' | 'p2c' | 'consistent-hash' | (string & {});
export interface UpstreamOptions { url: string; weight?: number; }
export interface HealthCheckOptions {
  path: string;
  intervalMs: number;
  timeoutMs?: number;
  expectedStatus?: number[];
  method?: 'GET' | 'HEAD' | (string & {});
  headers?: Record<string, string>;
}
export interface RetryOptions {
  attempts?: number;
  methods?: string[];
  backoffMs?: number;
  jitterMs?: number;
  maxBackoffMs?: number;
  maxRetryRate?: number;
  retryOn?: Array<'network' | 'timeout' | 'connect'>;
}
export interface CircuitBreakerOptions { failureThreshold?: number; cooldownMs?: number; slidingWindowSize?: number; minimumRequests?: number; maxHalfOpen?: number; }
export interface BulkheadOptions { maxConcurrentPerUpstream?: number; maxConcurrentPerRoute?: number; }
export interface RateLimitOptions {
  /** Bucket capacity: requests allowed before the bucket refills. */
  limit: number;
  /** Time in milliseconds for the bucket to refill from empty to full. */
  windowMs: number;
  /** Client identity source. Defaults to the peer address. */
  key?: 'ip' | 'header';
  /** Header name used when `key` is `header`; falls back to the peer address when absent. */
  header?: string;
  /** Scope buckets per route path. Defaults to true. */
  perRoute?: boolean;
  /** Maximum live buckets kept in memory before evicting the least recently used. */
  maxKeys?: number;
}
export interface CacheOptions {
  /** Maximum time a stored response is served. Defaults are capped by upstream Cache-Control. */
  ttlMs: number;
  /** Cacheable upstream statuses. Defaults to 200, 203, 204, 301 and 308. */
  statuses?: number[];
  /** Additional request headers that must match for a cache hit. `accept-encoding` is always included. */
  vary?: string[];
  /** Maximum stored entries per route. */
  maxEntries?: number;
  /** Maximum stored response body bytes per route. */
  maxBytes?: number;
  /** Maximum stored body size for a single response. Larger responses stream through uncached. */
  maxEntryBytes?: number;
}
export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds?: number;
}
export interface OutlierDetectionOptions { consecutive5xx?: number; intervalMs?: number; baseEjectionTimeMs?: number; }
export interface SsrfOptions {
  allowPrivate?: boolean;
  allowLocalhost?: boolean;
  allowLinkLocal?: boolean;
  /** @deprecated use allowLinkLocal */
  allowlinkLocal?: boolean;
  allowlist?: string[];
  blocklist?: string[];
}
export interface StickyOptions {
  cookie?: string;
  ttlMs?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'strict' | 'lax' | 'none' | 'Strict' | 'Lax' | 'None';
  /** Shared HMAC secret for signed sticky tokens. Defaults to a per-process random secret. */
  secret?: string;
}
export interface TimeoutsOptions { connectTimeoutMs?: number; headersTimeoutMs?: number; requestTimeoutMs?: number; idleTimeoutMs?: number; }
export interface RequestCompleteEvent {
  requestId: string;
  method: string;
  path: string;
  upstream: string;
  status: number;
  durationMs: number;
}
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
  rateLimit?: RateLimitOptions;
  cache?: CacheOptions;
  outlierDetection?: OutlierDetectionOptions;
  sticky?: StickyOptions;
  allowedHosts?: string[];
  hashKey?: 'ip' | 'path' | 'header' | string;
  hashHeader?: string;
  onRequestComplete?: (event: RequestCompleteEvent) => void;
}
export interface RouteBalancerRequestContext {
  readonly requestId: string;
  readonly routePath: string;
  readonly method: string;
  readonly pathname: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly signal: AbortSignal;
}
export interface RouteBalancerRequestDecision {
  /** Replacement pathname. Must remain within the originally matched route prefix. */
  pathname?: string;
  /** Header mutations; names must be listed in requestInterception.allowedHeaders. Set null to remove. */
  headers?: Record<string, string | null>;
  /** Reject the request before selecting or contacting an upstream. */
  reject?: { statusCode: number; message?: string };
}
export interface RouteBalancerPlugin {
  readonly name?: string;
  onRequest(context: RouteBalancerRequestContext): RouteBalancerRequestDecision | void | Promise<RouteBalancerRequestDecision | void>;
}
export interface RouteBalancerPluginRegistrationOptions {
  /** Modules exporting the plugin providers identified by `inject`. */
  imports?: any[];
  /** Optional providers scoped to the RouteBalancerModule instance. */
  providers?: Provider[];
  /** Injection tokens whose resolved values are request plugins. */
  inject?: InjectionToken[];
}
export interface RequestInterceptionOptions {
  /** Maximum duration of the complete ordered plugin chain. Defaults to 1000ms; maximum is 30000ms. */
  timeoutMs?: number;
  /** Request headers visible to plugins; defaults to none to avoid leaking credentials. */
  exposedHeaders?: string[];
  /** Explicit allowlist of headers plugins can add, replace, or remove. */
  allowedHeaders?: string[];
}
export interface RouteBalancerOptions {
  routes: RouteOptions[];
  trustProxy?: boolean;
  maxSockets?: number;
  keepAlive?: boolean;
  shutdownTimeoutMs?: number;
  ssrf?: SsrfOptions;
  requestInterception?: RequestInterceptionOptions;
}
export interface RouteBalancerAsyncOptions {
  imports?: any[];
  inject?: any[];
  plugins?: RouteBalancerPluginRegistrationOptions;
  useFactory: (...args: any[]) => Promise<RouteBalancerOptions> | RouteBalancerOptions;
}
export interface UpstreamState {
  url: string;
  weight: number;
  healthy: boolean;
  /** Operationally drained: excluded from selection while in-flight requests continue. */
  drained: boolean;
  active: number;
  requests: number;
  errors: number;
  successes: number;
  retries: number;
  healthCheckSuccesses: number;
  healthCheckFailures: number;
  consecutiveFailures: number;
  consecutive5xx: number;
  blockedUntil: number;
  probeInFlight: boolean;
  currentWeight: number;
  totalResponseTimeMs: number;
  responseCount: number;
  ewmaResponseTimeMs: number;
  /** Timestamp da última amostra de latência; base do decaimento das estratégias adaptativas. */
  ewmaObservedAt: number;
  ejectedUntil: number;
  ejectionCount: number;
  lastFailureAt: number;
  lastEjectionAt: number;
}
export interface RouteState { path: string; config: RouteOptions; upstreams: UpstreamState[]; cursor: number; weightedCursor: number; rateLimited: number; cacheHits: number; cacheMisses: number; cacheStores: number; }
export interface BalancerMetrics {
  routes: Array<{
    path: string;
    upstreams: UpstreamState[];
    rateLimited?: number;
    cacheHits?: number;
    cacheMisses?: number;
    cacheStores?: number;
  }>;
}
export interface RuntimeRouteReloadResult {
  /** Route paths introduced by the reload. */
  added: string[];
  /** Route paths removed from service. */
  removed: string[];
  /** Route paths whose configuration or upstream set changed. */
  updated: string[];
}
export interface ProxyRequest extends IncomingMessage { originalUrl?: string; }
export type ProxyResponse = ServerResponse;
export interface BalancerStrategy { name: string; select(route: RouteState, available: UpstreamState[]): UpstreamState | undefined; }
