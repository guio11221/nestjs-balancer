# NestJS Route Balancer

Reusable, extensible HTTP(S) reverse-proxy and load balancer for NestJS **Express** gateways.

> v0.4.0 is a developer preview. Do not expose an unreviewed configuration to untrusted users or deploy as a public edge gateway without security hardening and load testing.

## Features

- Static HTTP/HTTPS upstreams, host/path/query forwarding, optional prefix stripping
- Round Robin, Smooth Weighted Round Robin, Least Connections (weighted), Random, custom strategy registry
- TCP connection pooling (`keepAlive`, `maxSockets`)
- Periodic active health probes and passive circuit-breaker recovery after cooldown
- Configurable, safe GET/HEAD failover to a distinct upstream on pre-response **transport failures**
- Per-upstream process-local metrics: requests, active, errors, successes, circuit state
- `forRoot` and `forRootAsync` compatible with NestJS 10/11
- Integration tests with real local upstream servers; GitHub Actions CI; agent-oriented skills

## Install

```bash
npm install nestjs-balancer
```

Configure the Express Nest application **with bodyParser disabled**, or requests may be consumed before streaming to upstreams:

```ts
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
async function main() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  await app.listen(3000);
}
void main();
```

```ts
import { Module } from "@nestjs/common";
import { RouteBalancerModule } from "nestjs-balancer";

@Module({
  imports: [
    RouteBalancerModule.forRoot({
      keepAlive: true,
      maxSockets: 128,
      trustProxy: false,
      routes: [
        {
          path: "/api",
          upstreams: [
            { url: "http://127.0.0.1:3001", weight: 3 },
            { url: "http://127.0.0.1:3002", weight: 1 },
          ],
          strategy: "weighted-round-robin",
          timeoutMs: 30000,
          changeOrigin: true,
          stripPrefix: false,
          retry: { attempts: 1, methods: ["GET", "HEAD"], backoffMs: 25 },
          circuitBreaker: { failureThreshold: 2, cooldownMs: 10000 },
          healthCheck: { path: "/health", intervalMs: 5000, timeoutMs: 1500 },
        },
      ],
    }),
  ],
})
export class AppModule {}
```

## Custom strategy

```ts
import { registerStrategy } from "nestjs-balancer";
registerStrategy({
  name: "fewest-errors",
  select(_route, available) {
    return [...available].sort((a, b) => a.errors - b.errors)[0];
  },
});
```

Register before creating the Nest application, then use `strategy: 'fewest-errors'`.

## Monitoring

Inject `RouteBalancerService` in providers within the module scope and call `metrics()` for a **snapshot**. This does not expose a public endpoint automatically.

## Development

```bash
npm install
npm run check
npm run pack:check
node examples/basic/upstreams.cjs
# in another terminal:
node examples/basic/gateway.cjs
```

See `skills/`, `AGENTS.md`, `SECURITY.md`, and `CONTRIBUTING.md`.

## Supported / unsupported

| Capability                           | Status                                                    |
| ------------------------------------ | --------------------------------------------------------- |
| REST / JSON / conventional HTTP APIs | Supported with streaming middleware                       |
| GraphQL over HTTP                    | Supported as HTTP requests (no GraphQL-aware routing)     |
| SSE / large streaming responses      | HTTP stream forwarding; verify timeouts for long sessions |
| HTTPS upstreams                      | Supported                                                 |
| Fastify                              | Not supported in this build                               |
| WebSocket upgrades                   | Not supported                                             |
| gRPC / HTTP/2                        | Not supported                                             |
| Automatic Kubernetes discovery       | Not supported                                             |
| Distributed Redis rate limiting      | Not supported                                             |
| OpenTelemetry / Prometheus export    | Not yet implemented                                       |

## Safety and operational limitations

- Targets must be trusted, configuration-time HTTP(S) origins. Do not load target URLs directly from arbitrary user input (SSRF risk).
- Configure firewall/egress controls, DNS and upstream identity appropriately. DNS rebinding, metadata IPs and internal-network exposure are not prevented by the library.
- Retry is intentionally restricted to **bodyless GET/HEAD** and only before upstream response headers. Failed POST/PUT/PATCH are never replayed. HTTP 5xx does **not** trigger retry.
- A route-level timeout covers the attempt until the response completes; tune for SSE/long streaming. Additional granular idle/connect/response timeout policies remain future work.
- Health checks mark an instance healthy when matching status is returned. Passive errors open circuits after a threshold; recovery uses a single half-open probe per target after cooldown (or active probes).
- The proxy is an HTTP/1.x Express middleware. Hop-by-hop headers are stripped; streaming and forwarded headers require careful reverse-proxy deployment validation.
- Runtime route updates, websocket upgrades, HTTP/2 and gRPC use protocol mechanisms not implemented here.

## License

MIT

## Project engineering documentation

- [Architecture and extension contracts](docs/ARCHITECTURE.md)
- [Security hardening](docs/SECURITY-HARDENING.md)
- [Regression and integration testing](docs/TESTING.md)
- [Contributor guide](CONTRIBUTING.md)
- [AI agent contribution instructions](AGENTS.md)
- [AI development skills](skills/README.md)

### Failure semantics

- Only transport/protocol failures open a passive circuit; valid HTTP 500 responses remain upstream responses.
- Retry is limited to **bodyless GET/HEAD** that fail before downstream response headers have been written.
- Requests to a downed upstream recover after the circuit cooldown using a half-open trial (or a successful active health check).
- Requests are streamed, not buffered, and large file uploads need upstream/ingress timeouts configured appropriately.
- The library is not a full API gateway and does not provide authentication, gRPC/HTTP2, WebSocket upgrades, or Fastify compatibility.

### Production readiness

This release is an **unverified developer preview**. Install dependencies, run `npm run check`, confirm tests on your supported NestJS versions and adapters, perform security review and load testing before using on public traffic.

### Validation record (2026-10-24)

24/24 Node.js tests passed against a local isolated transpilation harness with NestJS decorators stubbed. TypeScript source syntax also checked without errors. This is **not** a substitute for an installed-dependencies `npm run check`, a NestJS integration test, or production verification; npm registry DNS was unavailable in this execution environment.

## Experimental adapters (v0.4.0)

The `attachWebSocketBalancer`, `attachFastifyBalancer`, and `createHttp2Balancer` exports are **opt-in**. The HTTP/2 transport is experimental h2c-to-h2c only and must **not** be used as a production gRPC proxy. The new `prometheusMetrics` export formats service metrics for a protected endpoint.

See [transport compatibility](docs/TRANSPORTS.md), [metrics](docs/METRICS.md), and [benchmarks](docs/BENCHMARKS.md). Full typecheck and NestJS integration are pending a real dependency installation.
