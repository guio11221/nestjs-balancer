# Prometheus metrics

`prometheusMetrics(service.metrics())` formats in-memory per-upstream counters in Prometheus exposition format. It does not open a public endpoint automatically.

```ts
import { Controller, Get, Header } from '@nestjs/common';
import { RouteBalancerService, prometheusMetrics } from 'nestjs-balancer';

@Controller('_internal')
export class MetricsController {
  constructor(private readonly balancer: RouteBalancerService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render(): string {
    return prometheusMetrics(this.balancer.metrics());
  }
}
```

Secure the endpoint with an internal network policy and authentication. The metrics are per-process; aggregate them in Prometheus. No OpenTelemetry SDK instrumentation is bundled. For distributed tracing, add it at the hosting application boundary and propagate trace context according to your security policy.

Counters and gauges include `route_balancer_upstream_requests_total`, `errors_total`, `successes_total`, `retries_total`, `active`, `healthy`, `drained`, `weight`, `health_check_successes_total`, `health_check_failures_total`, `consecutive_failures` and `consecutive_5xx`. The per-route counters `route_balancer_route_rate_limited_total`, `route_balancer_route_cache_hits_total`, `route_balancer_route_cache_misses_total` and `route_balancer_route_cache_stores_total` expose [rate limiting](rate-limiting.md) and [response caching](caching.md). Sticky hits are applied before selection and do not create a separate metric. Runtime reloads replace the reported table; state is carried only for the same route path and upstream origin.

**Important**: this module does not yet emit latency histograms, circuit-open gauges, retry-reason breakdowns or HTTP/2 session metrics. The exposed counter state resets on process restart.
