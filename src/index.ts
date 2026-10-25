export { RouteBalancerModule } from './balancer.module';
export { RouteBalancerService } from './balancer.service';
export { RouteBalancerMiddleware } from './proxy/middleware';
export { selectUpstream, registerStrategy } from './strategies/select';
export { sanitizeHeaders } from './proxy/headers';
export type { RouteBalancerOptions, RouteBalancerAsyncOptions, RouteOptions, RetryOptions, CircuitBreakerOptions, UpstreamOptions, HealthCheckOptions, BalancingStrategy, BalancerStrategy, UpstreamState, RouteState, BalancerMetrics } from './types';

export { prometheusMetrics } from './telemetry/prometheus';
export { attachFastifyBalancer } from './adapters/fastify';
export { attachWebSocketBalancer } from './transports/websocket';
export { createHttp2Balancer } from './transports/http2';
