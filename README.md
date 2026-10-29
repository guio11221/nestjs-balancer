# NestJS Route Balancer

Reusable, extensible HTTP(S) reverse-proxy and load balancer for NestJS **Express** gateways.

> v0.9.0 is a developer preview. Do not expose an unreviewed configuration to untrusted users or deploy as a public edge gateway without security hardening and load testing.

## Features

- Static HTTP/HTTPS upstreams, host/path/query forwarding, optional prefix stripping
- Round Robin, Smooth Weighted Round Robin, Least Connections (weighted), Random, Consistent Hash (weighted virtual nodes), adaptive Peak EWMA and Power of Two Choices, custom strategy registry
- TCP connection pooling (`keepAlive`, `maxSockets`), opt-in WebSocket upgrade tunneling and h2c transport
- Granular connect, headers, whole-request and idle timeouts; bounded exponential backoff with a retry budget
- Signed opaque sticky sessions, outlier ejection after consecutive 5xx, passive circuit-breaker recovery and active health probes
- Local token-bucket rate limiting per route and client (address or header key) with `RateLimit-*` headers and `429` + `Retry-After`
- Opt-in `GET`/`HEAD` response caching with TTL, `Vary`, LRU memory budgets, request coalescing and unsafe-method invalidation
- Configurable, safe GET/HEAD failover to a distinct upstream on pre-response **transport failures**
- `allowedHosts` host filtering, graceful shutdown draining, SSRF checks for private/IPv6/mapped addresses
- Per-upstream process-local metrics: requests, active, errors, successes, retries, 5xx streak, circuit state
- Runtime control: drain/resume upstreams, adjust weights and atomically reload the route table without restart, carrying counters and circuit state
- `forRoot` and `forRootAsync` compatible with NestJS 10/11, with per-module NestJS DI request plugins and bounded interception
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
      shutdownTimeoutMs: 10000,
      routes: [
        {
          path: "/api",
          upstreams: [
            { url: "http://127.0.0.1:3001", weight: 3 },
            { url: "http://127.0.0.1:3002", weight: 1 },
          ],
          strategy: "weighted-round-robin",
          timeouts: {
            connectTimeoutMs: 2000,
            headersTimeoutMs: 10000,
            requestTimeoutMs: 30000,
            idleTimeoutMs: 60000,
          },
          changeOrigin: true,
          stripPrefix: false,
          allowedHosts: ["api.example.com"],
          retry: { attempts: 1, methods: ["GET", "HEAD"], retryOn: ["network", "connect"], backoffMs: 25, maxRetryRate: 0.1 },
          circuitBreaker: { failureThreshold: 2, cooldownMs: 10000 },
          outlierDetection: { consecutive5xx: 5, baseEjectionTimeMs: 30000 },
          sticky: { cookie: "lb", ttlMs: 300000 },
          healthCheck: { path: "/health", intervalMs: 5000, timeoutMs: 1500 },
        },
      ],
    }),
  ],
})
export class AppModule {}
```

## Request plugins and interception

Plugins are trusted NestJS providers and run sequentially after route/Host validation but before upstream selection. Provide tokens to `forRoot` or `forRootAsync`; the second argument/`plugins` option defines the provider scope and deterministic order:

```ts
const tenantPlugin = {
  async onRequest(context) {
    // Headers are redacted unless explicitly exposed. No body, raw request, response, or upstream URL is provided.
    const tenant = context.headers["x-tenant"];
    if (!tenant) return { reject: { statusCode: 401, message: "Tenant required" } };
    return {
      pathname: `${context.routePath}/tenant/${encodeURIComponent(tenant)}`,
      headers: { "x-tenant-id": tenant },
    };
  },
};

RouteBalancerModule.forRoot({
  routes: [{ path: "/api", upstreams: ["http://127.0.0.1:3001"] }],
  requestInterception: {
    exposedHeaders: ["x-tenant"],
    allowedHeaders: ["x-tenant-id"],
    timeoutMs: 1000,
  },
}, {
  providers: [{ provide: "TENANT_PLUGIN", useValue: tenantPlugin }],
  inject: ["TENANT_PLUGIN"],
});

// The same plugin provider registration can be used with forRootAsync:
RouteBalancerModule.forRootAsync({
  imports: [ConfigurationModule],
  inject: ["BALANCER_CONFIGURATION"],
  useFactory: configuration => ({ routes: configuration.routes }),
  plugins: {
    imports: [PluginModule],
    inject: ["TENANT_PLUGIN"],
  },
});
```

The same `plugins: { imports, providers, inject }` option is available in `forRootAsync`. Path rewrites must remain inside the initially matched route and keep the original query; encoded/control-character paths are rejected. Plugins may only edit explicitly allowlisted headers; method, body and upstream are immutable. The default exposed/allowed header lists are empty, and protected headers cannot be exposed or edited. The whole plugin chain has one timeout (default 1 second, maximum 30 seconds), a maximum of 32 plugins, and receives an abort signal for client cancellation and shutdown. Exceptions are sanitized; timeout, invalid decisions and cancellation fail closed before contacting an upstream. Plugins are trusted in-process code, not a sandbox; do not run blocking CPU work in them.

## Adaptive strategies

`peak-ewma` scores every eligible upstream and picks the lowest score; `p2c` samples two random upstreams and keeps the better one, which keeps selection cheap with many instances. Both use the same score: decayed EWMA latency × (1 + in-flight requests) ÷ weight.

- Latency decays exponentially with a 10-second window starting from the last recorded sample, so an upstream that was slow once does not stay penalized forever.
- Upstreams without a latency sample score neutral (0) and receive a warm-up request; ties are resolved by normalized load and rotation.
- Scores are process-local, like the rest of the metrics, and complement circuit breaking and outlier ejection rather than replacing them.

```ts
routes: [{ path: "/api", upstreams: ["http://127.0.0.1:3001", "http://127.0.0.1:3002"], strategy: "peak-ewma" }]
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

## Rate limiting

```ts
RouteBalancerModule.forRoot({
  routes: [
    {
      path: "/api",
      upstreams: ["http://10.0.0.11:8080", "http://10.0.0.12:8080"],
      rateLimit: { limit: 100, windowMs: 60_000 },
    },
  ],
});
```

A local token bucket per route and client allows bursts of `limit` and then refills over `windowMs`. Key by peer address (default) or by a header such as `x-api-key`; `perRoute: false` shares one bucket across routes and `maxKeys` bounds memory with LRU eviction. Accepted requests receive `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; rejections are `429` with `Retry-After` and never reach plugins or upstreams. Buckets are process-local: the effective limit is `limit × replicas`. See [rate limiting](docs/guides/rate-limiting.md).

## Response caching

```ts
RouteBalancerModule.forRoot({
  routes: [
    {
      path: "/catalog",
      upstreams: ["http://10.0.0.11:8080", "http://10.0.0.12:8080"],
      cache: { ttlMs: 30_000, vary: ["accept-language"], maxEntryBytes: 512 * 1024 },
    },
  ],
});
```

Cache is opt-in per route, streams misses while buffering a bounded copy, and coalesces concurrent misses into one upstream request. Responses with `Authorization`, `Cookie`, `Range`, `Set-Cookie`, `no-store`, `private`, `no-cache`, unlisted `Vary` headers or non-cacheable statuses are never stored. Hits carry `x-cache: HIT` and `Age`; misses carry `x-cache: MISS`; cache-eligible requests whose response is not storable carry `x-cache: BYPASS`, while request-level bypasses carry no `x-cache` header. Unsafe methods purge the same pathname, `reloadRoutes` clears the cache and `clearCache(routePath?)` purges on demand. Entries are process-local. See [response caching](docs/guides/caching.md).

## Runtime control

`RouteBalancerService` exposes operational controls; no admin endpoint is registered automatically. Wrap them in your own guarded controller or ops script:

```ts
import { Controller, NotFoundException, Post, Body, UseGuards } from "@nestjs/common";
import { RouteBalancerService, type RouteOptions } from "nestjs-balancer";

@Controller("_internal/balancer")
@UseGuards(InternalAdminGuard)
export class BalancerAdminController {
  constructor(private readonly balancer: RouteBalancerService) {}

  @Post("routes/reload")
  reload(@Body() body: { routes: RouteOptions[] }) {
    // Bootstrap-only options must stay identical, so start from the current ones.
    return this.balancer.reloadRoutes({ ...this.balancer.options, routes: body.routes });
  }

  @Post("upstreams/drain")
  drain(@Body() body: { path: string; upstream: string }) {
    if (!this.balancer.drainUpstream(body.path, body.upstream)) throw new NotFoundException();
    return { drained: true };
  }

  @Post("upstreams/resume")
  resume(@Body() body: { path: string; upstream: string }) {
    if (!this.balancer.resumeUpstream(body.path, body.upstream)) throw new NotFoundException();
    return { drained: false };
  }

  @Post("upstreams/:weight")
  weight(@Body() body: { path: string; upstream: string; weight: number }) {
    if (!this.balancer.setUpstreamWeight(body.path, body.upstream, body.weight)) throw new NotFoundException();
    return { weight: body.weight };
  }
}
```

Semantics:

- `drainUpstream(path, url)` excludes an upstream from new selections while in-flight requests keep running. `resumeUpstream` reverses it; circuit and ejection state are untouched. When every upstream is drained, requests receive `503`.
- `setUpstreamWeight(path, url, weight)` accepts integers `1..1000`. Runtime weights are overwritten by the configured value on the next reload.
- `reloadRoutes(options)` validates the full replacement first, then swaps atomically and returns `{ added, removed, updated }`. Invalid input leaves the previous table untouched.
- Upstreams that keep the same route path and origin carry counters, EWMA latency, circuit state and drain flags. Route moves start with fresh state, and in-flight requests finish on the previous snapshot without contributing to the new counters.
- `trustProxy`, `maxSockets`, `keepAlive`, `shutdownTimeoutMs`, `ssrf` and `requestInterception` are bootstrap-only; `reloadRoutes` throws if they change.
- Health-check and outlier timers are rebuilt for the new table.

## More examples

[docs/guides/examples.md](docs/guides/examples.md) walks through async configuration, weighted routing with sticky sessions, resilience tuning, rate limiting, plugins, Prometheus exposition, custom strategies and the opt-in transports, plus a troubleshooting table. Runnable scripts live in `examples/basic/`. The full documentation map is in [docs/README.md](docs/README.md).

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
| SSE / large streaming responses      | HTTP stream forwarding; use explicit idle/request timeouts |
| HTTPS upstreams                      | Supported                                                 |
| Fastify                              | Opt-in manual hook (`attachFastifyBalancer`)              |
| WebSocket upgrades                   | Experimental opt-in HTTP/1.1 tunneling                    |
| gRPC / HTTP/2                        | Experimental h2c-to-h2c; no TLS or production gRPC claim  |
| Automatic Kubernetes discovery       | Not supported                                             |
| Distributed Redis rate limiting      | Not supported                                             |
| Local rate limiting                  | Per-process token bucket per route/client                  |
| Local response caching               | Opt-in GET/HEAD, per-process, memory-bounded              |
| Prometheus export                    | Formatter only; endpoint and auth are application-owned   |

## Safety and operational limitations

- Targets must be trusted, configuration-time HTTP(S) origins. Do not load target URLs directly from arbitrary user input (SSRF risk).
- The built-in SSRF guard rejects malformed, credentialed, private, loopback, link-local and IPv4-mapped IPv6 targets when enabled. Configure firewall/egress controls and DNS as defense in depth; application-level DNS rebinding protection is still required.
- Retry is intentionally restricted to **bodyless GET/HEAD** and only before upstream response headers. Failed POST/PUT/PATCH are never replayed. HTTP 5xx does **not** trigger retry; use outlier ejection for 5xx streaks.
- The response cache is in-memory and per process; it never stores authenticated, cookie-bearing, ranged or private/no-store responses. With multiple replicas, a write purges only the replica that handled it.
- `connectTimeoutMs`, `headersTimeoutMs`, `requestTimeoutMs` and `idleTimeoutMs` cover connection, first byte, whole attempt and response inactivity respectively. A value of `0` disables that timer; tune for SSE and long uploads.
- Sticky cookies are HMAC-signed opaque tokens. Set an explicit `sticky.secret` when running multiple replicas; otherwise the secret is process-local and cookies are invalid after restart.
- `allowedHosts` enforces an exact or `*.suffix` Host allowlist (HTTP/1 only) and rejects malformed hosts with `421`.
- Client `x-request-id` values are forwarded and echoed only when they are 1–128 visible ASCII characters; anything else is replaced with a generated id. Client forwarding metadata is discarded unless `trustProxy` is enabled, empty values are never emitted, and the peer address is appended to the existing `x-forwarded-for` chain.
- Synthetic gateway errors (`400`, `421`, `502`, `503`, `504`) are JSON with `Content-Length` and `Cache-Control: no-store`; the shutdown `503` also sends `Connection: close`.
- Health checks mark an instance healthy when matching status is returned. Passive transport failures open circuits; consecutive 5xx responses eject instances temporarily. Recovery uses a half-open probe or active checks.
- The proxy is an HTTP/1.x Express middleware. Hop-by-hop headers are stripped; streaming and forwarded headers require careful reverse-proxy deployment validation.
- Only the route table is reloadable at runtime. `trustProxy`, `maxSockets`, `keepAlive`, `shutdownTimeoutMs`, `ssrf` and `requestInterception` remain bootstrap-only. WebSocket/Fastify/HTTP2 are opt-in transports, not automatic Nest adapters.

## License

MIT

## Project engineering documentation

- [Documentation index](docs/README.md)
- [Usage examples and recipes](docs/guides/examples.md)
- [Rate limiting](docs/guides/rate-limiting.md)
- [Response caching](docs/guides/caching.md)
- [Configuration reference](docs/reference/configuration.md)
- [Architecture and extension contracts](docs/reference/architecture.md)
- [Security hardening](docs/operations/security-hardening.md)
- [Regression and integration testing](docs/operations/testing.md)
- [Contributor guide](CONTRIBUTING.md)
- [AI agent contribution instructions](AGENTS.md)
- [AI development skills](skills/README.md)

### Failure semantics

- Transport/protocol failures open a passive circuit. HTTP 5xx responses are returned to the client and also count toward outlier ejection.
- Retry is limited to **bodyless GET/HEAD** that fail before downstream response headers have been written, and is bounded by `maxRetryRate`.
- Requests to a downed upstream recover after the circuit cooldown using a half-open trial (or a successful active health check).
- Requests are streamed, not buffered, and large file uploads need upstream/ingress timeouts configured appropriately.
- The library is not a full API gateway and does not provide authentication, authorization, distributed rate limiting or automatic WebSocket/Fastify/HTTP2 adapters.

### Production readiness

This release is an **unverified developer preview**. Install dependencies, run `npm run check`, confirm tests on your supported NestJS versions and adapters, perform security review and load testing before using on public traffic.

### Validation record (2026-10-29)

`npm run check` passed with TypeScript typechecking, compilation, 92 unit tests, 60 HTTP/NestJS integration tests and 11 transport tests (163 total) on Node.js v24.15.0 for Windows with installed dependencies. The suite covers timeouts, sticky sessions, SSRF/IPv4-compatible/IPv6 rejection, retry policy/budget, outlier ejection, adaptive selection scoring and decay, local rate limiting (bucket math, identity, headers, `429`, eviction, reload reset), response caching (keys/variants, TTL, LRU budgets, bypass rules, coalescing, invalidation, reload races, `x-cache`), runtime drain/weights/route reload (including in-flight reloads and atomic rejection), request-id and forwarding-header hygiene, synthetic-error framing, shutdown draining, HTTP/2 session reuse and WebSocket lifecycle. This is a regression baseline, not production verification.

## Experimental adapters (v0.9.0)

The `attachWebSocketBalancer`, `attachFastifyBalancer`, and `createHttp2Balancer` exports are **opt-in**. The HTTP/2 transport is h2c-to-h2c only, reuses one session per origin and has protocol regression tests; it must **not** be used as a production gRPC proxy without TLS, trailers, cancellation and load testing. `prometheusMetrics` formats service metrics for a protected endpoint.

See [transport compatibility](docs/guides/transports.md), [metrics](docs/guides/metrics.md), and [benchmarks](docs/operations/benchmarks.md).
