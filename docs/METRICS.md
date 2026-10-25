# Prometheus metrics

`prometheusMetrics(service.metrics())` formats in-memory per-upstream counters in Prometheus exposition format. It does not open a public endpoint automatically.

```ts
import { Controller, Get, Header } from '@nestjs/common';
import { RouteBalancerService, prometheusMetrics } from 'nestjs-route-balancer-kit';

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

**Important**: this module does not yet emit latency histograms, circuit-open gauges, retry reasons or HTTP/2 session metrics. The exposed counter state resets on process restart.
