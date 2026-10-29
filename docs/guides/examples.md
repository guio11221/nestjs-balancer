# Usage examples

Copy-paste recipes for the HTTP/1.1 NestJS balancer. All examples assume the Express adapter with **body parsing disabled**, because the proxy streams the original request:

```ts
const app = await NestFactory.create(AppModule, { bodyParser: false });
```

Related references: [configuration](../reference/configuration.md), [architecture](../reference/architecture.md), [rate limiting](rate-limiting.md), [transports](transports.md), [metrics](metrics.md), [security checklist](../operations/security-hardening.md).

## 1. Minimal gateway

```ts
// app.module.ts
import { Module } from "@nestjs/common";
import { RouteBalancerModule } from "nestjs-balancer";

@Module({
  imports: [
    RouteBalancerModule.forRoot({
      routes: [
        {
          path: "/api",
          upstreams: ["http://127.0.0.1:3001", "http://127.0.0.1:3002"],
        },
      ],
    }),
  ],
})
export class AppModule {}
```

```ts
// main.ts
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks();
  await app.listen(3000);
}

void main();
```

```bash
# Requests are load balanced across the two upstreams.
curl -i http://127.0.0.1:3000/api/users?page=2
```

`GET /api` forwards `/api`; a request to `/apix` is not matched and continues to the next Express handler (`404` unless your app defines one). The longest configured prefix wins.

## 2. Configuration from environment (async)

```ts
import { Module } from "@nestjs/common";
import { RouteBalancerModule } from "nestjs-balancer";

const CONFIGURATION = "BALANCER_CONFIGURATION";

@Module({
  providers: [
    {
      provide: CONFIGURATION,
      useValue: {
        users: (process.env.USERS_UPSTREAMS ?? "http://127.0.0.1:3001").split(","),
        orders: (process.env.ORDERS_UPSTREAMS ?? "http://127.0.0.1:4001").split(","),
        stickySecret: process.env.STICKY_SECRET,
      },
    },
  ],
  exports: [CONFIGURATION],
})
export class ConfigurationModule {}

@Module({
  imports: [
    RouteBalancerModule.forRootAsync({
      imports: [ConfigurationModule],
      inject: [CONFIGURATION],
      useFactory: (configuration: {
        users: string[];
        orders: string[];
        stickySecret?: string;
      }) => ({
        keepAlive: true,
        maxSockets: 256,
        routes: [
          { path: "/api/users", upstreams: configuration.users },
          {
            path: "/api/orders",
            upstreams: configuration.orders,
            sticky: { cookie: "lb_orders", secret: configuration.stickySecret, ttlMs: 300_000 },
          },
        ],
      }),
    }),
  ],
})
export class AppModule {}
```

Route configuration is static after bootstrap: changing environment variables requires a restart.

## 3. Weights, timeouts, retries and sticky sessions

```ts
RouteBalancerModule.forRoot({
  routes: [
    {
      path: "/api",
      upstreams: [
        { url: "http://10.0.0.11:8080", weight: 3 },
        { url: "http://10.0.0.12:8080", weight: 1 },
      ],
      strategy: "weighted-round-robin",
      timeouts: {
        connectTimeoutMs: 2000,
        headersTimeoutMs: 10_000,
        requestTimeoutMs: 30_000,
        idleTimeoutMs: 60_000,
      },
      // Only bodyless GET/HEAD that fail before any response header are retried.
      retry: {
        attempts: 2,
        methods: ["GET", "HEAD"],
        retryOn: ["connect", "network", "timeout"],
        backoffMs: 25,
        jitterMs: 10,
        maxBackoffMs: 500,
        maxRetryRate: 0.1,
      },
      sticky: {
        cookie: "lb",
        ttlMs: 300_000,
        secret: process.env.STICKY_SECRET,
        secure: true,
        sameSite: "lax",
      },
      changeOrigin: true,
      stripPrefix: false,
    },
  ],
});
```

Notes:

- `secure: true` requires HTTPS at the client edge; health checks and upstream calls are unaffected.
- `timeouts: 0` disables a specific timer. Set `idleTimeoutMs: 0` only when long-lived streaming responses must never be cut.
- Sticky cookies are HMAC-signed and opaque. Configure the same `sticky.secret` on every replica.
- Failed `POST`/`PUT`/`PATCH` requests are never replayed.

## 4. Resilience: circuit breaker, outlier ejection and health checks

```ts
RouteBalancerModule.forRoot({
  routes: [
    {
      path: "/api",
      upstreams: ["http://10.0.0.11:8080", "http://10.0.0.12:8080"],
      circuitBreaker: {
        failureThreshold: 3,
        cooldownMs: 10_000,
        slidingWindowSize: 60,
        minimumRequests: 10,
        maxHalfOpen: 1,
      },
      outlierDetection: {
        consecutive5xx: 5,
        intervalMs: 30_000,
        baseEjectionTimeMs: 30_000,
      },
      healthCheck: {
        path: "/health",
        intervalMs: 5000,
        timeoutMs: 1500,
        expectedStatus: [200, 204],
        method: "GET",
        headers: { "x-probe": "gateway" },
      },
    },
  ],
});
```

- A transport failure opens a passive circuit after `failureThreshold` failures and recovers with a single half-open probe (or an active health check).
- Consecutive `5xx` responses are returned to the client but also eject the upstream for a growing backoff window.
- Keep the host application's own readiness/liveness endpoints separate; this module never exposes them.

## 5. Request plugins: tenant header and early rejection

Plugins are trusted NestJS providers. They run in registration order, after route/Host validation and before upstream selection.

```ts
import { Module } from "@nestjs/common";
import { RouteBalancerModule } from "nestjs-balancer";

const TENANT_PLUGIN = {
  name: "tenant",
  async onRequest(context: {
    routePath: string;
    headers: Readonly<Record<string, string | readonly string[]>>;
    signal: AbortSignal;
  }) {
    const tenant = context.headers["x-tenant"];
    if (!tenant) return { reject: { statusCode: 401, message: "Tenant required" } };
    if (typeof tenant !== "string" || !/^[a-z0-9-]{1,32}$/.test(tenant)) {
      return { reject: { statusCode: 400, message: "Invalid tenant" } };
    }
    return {
      // Rewrites must stay inside the matched route and keep the query string.
      pathname: `${context.routePath}/tenants/${tenant}`,
      // Only headers listed in requestInterception.allowedHeaders may change.
      headers: { "x-tenant-id": tenant },
    };
  },
};

@Module({
  imports: [
    RouteBalancerModule.forRoot(
      {
        routes: [{ path: "/api", upstreams: ["http://10.0.0.11:8080"] }],
        requestInterception: {
          exposedHeaders: ["x-tenant"],
          allowedHeaders: ["x-tenant-id"],
          timeoutMs: 500,
        },
      },
      {
        providers: [{ provide: "TENANT_PLUGIN", useValue: TENANT_PLUGIN }],
        inject: ["TENANT_PLUGIN"],
      },
    ),
  ],
})
export class AppModule {}
```

Plugins never receive the body, method, upstream list, raw request/response or arbitrary headers. A rejection produces a JSON response and never contacts an upstream. Timeouts, exceptions and invalid decisions fail closed.

## 6. Metrics endpoint

```ts
import { Controller, Get, Header, UseGuards } from "@nestjs/common";
import { RouteBalancerService, prometheusMetrics } from "nestjs-balancer";
import { InternalTokenGuard } from "./internal-token.guard";

@Controller("_internal")
export class MetricsController {
  constructor(private readonly balancer: RouteBalancerService) {}

  @Get("metrics")
  @UseGuards(InternalTokenGuard)
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  render(): string {
    return prometheusMetrics(this.balancer.metrics());
  }
}
```

```yaml
# prometheus.yml
scrape_configs:
  - job_name: nestjs-balancer
    metrics_path: /_internal/metrics
    static_configs:
      - targets: ["gateway.internal:3000"]
```

```bash
curl -s http://127.0.0.1:3000/_internal/metrics | head
```

Metrics are process-local and reset on restart. Secure the endpoint at the network and application layers; the module never exposes it automatically.

## 7. Custom balancing strategy

```ts
import { registerStrategy } from "nestjs-balancer";

// Register once, before NestFactory.create().
registerStrategy({
  name: "fewest-errors",
  select(_route, available) {
    return [...available].sort((a, b) => a.errors - b.errors || a.active - b.active)[0];
  },
});
```

```ts
routes: [{ path: "/api", upstreams: ["http://10.0.0.11:8080"], strategy: "fewest-errors" }];
```

A custom strategy must return an upstream from the provided `available` list; anything else throws and the request fails before contacting an upstream. Built-ins: `round-robin`, `weighted-round-robin`, `least-connections`, `least-response-time`, `peak-ewma`, `p2c`, `random`, `consistent-hash`.

## 8. Multiple routes with Host filtering and prefix stripping

```ts
RouteBalancerModule.forRoot({
  trustProxy: false,
  routes: [
    {
      path: "/api/v1",
      upstreams: ["http://10.0.0.11:8080"],
      stripPrefix: true, // /api/v1/users -> /users
      allowedHosts: ["api.example.com", "*.internal.example.com"],
    },
    {
      path: "/static",
      upstreams: ["http://10.0.0.12:8080"],
      strategy: "consistent-hash",
      hashKey: "ip",
      timeouts: { connectTimeoutMs: 1000, requestTimeoutMs: 10_000 },
    },
  ],
});
```

Requests with a malformed or mismatched `Host` receive `421 Misdirected Request`. Only enable `trustProxy` when every request passes through a trusted ingress that replaces client forwarding headers.

## 9. Graceful shutdown

```ts
const app = await NestFactory.create(AppModule, { bodyParser: false });
app.enableShutdownHooks();

process.on("SIGTERM", () => {
  void app.close(); // stops accepting, aborts in-flight work after shutdownTimeoutMs
});
```

Configure `shutdownTimeoutMs` on `forRoot`/`forRootAsync`. During draining, matched requests receive `503` with `Connection: close`; new connections are rejected by `httpServer.close()`.

## 10. Optional transports

These are opt-in and experimental; see [transports](transports.md) for limitations.

```ts
import {
  RouteBalancerMiddleware,
  RouteBalancerService,
  attachFastifyBalancer,
  attachWebSocketBalancer,
  createHttp2Balancer,
} from "nestjs-balancer";

// WebSocket upgrade tunneling on the existing HTTP/1.1 server.
const disposeUpgrades = attachWebSocketBalancer(
  app.getHttpServer(),
  app.get(RouteBalancerService),
);

// Fastify: register the raw onRequest hook before application routes.
attachFastifyBalancer(
  app.getHttpAdapter().getInstance(),
  app.get(RouteBalancerService),
  app.get(RouteBalancerMiddleware),
);

// HTTP/2 cleartext gateway, separate listener.
createHttp2Balancer(app.get(RouteBalancerService)).listen(8443);
```

`@nestjs/platform-fastify` is not a dependency of this package; install and configure it in the host application.

## 11. Local development and manual checks

```bash
npm install
npm run check

# Terminal 1: two JSON upstreams on 3001/3002.
node examples/basic/upstreams.cjs

# Terminal 2: gateway on 3000.
node examples/basic/gateway.cjs

# Terminal 3:
curl -s http://127.0.0.1:3000/api/users | jq
curl -s -X POST http://127.0.0.1:3000/api/users -H 'content-type: application/json' -d '{"name":"ana"}' | jq
```

## 12. Rate limiting per route and client

```ts
RouteBalancerModule.forRoot({
  routes: [
    {
      path: "/api",
      upstreams: ["http://10.0.0.11:8080", "http://10.0.0.12:8080"],
      // Burst of 100 requests, then about 1.6 req/s sustained per client.
      rateLimit: { limit: 100, windowMs: 60_000 },
    },
    {
      path: "/partner",
      upstreams: ["http://10.0.0.13:8080"],
      // Quota per API key; missing header falls back to the client address.
      rateLimit: { limit: 1000, windowMs: 60_000, key: "header", header: "x-api-key" },
    },
  ],
});
```

```bash
curl -i http://127.0.0.1:3000/api/users
# RateLimit-Limit: 100
# RateLimit-Remaining: 99
# RateLimit-Reset: 1

curl -i -H 'x-api-key: partner-1' http://127.0.0.1:3000/partner/orders
```

Rejected requests get `429` with `Retry-After` before any plugin or upstream work. Buckets are per process; details, memory bounds and multi-replica caveats are in [rate limiting](rate-limiting.md).

## 13. Response caching

```ts
RouteBalancerModule.forRoot({
  routes: [
    {
      path: "/catalog",
      upstreams: ["http://10.0.0.11:8080", "http://10.0.0.12:8080"],
      cache: {
        ttlMs: 30_000,
        vary: ["accept-language"],
        maxEntries: 2_000,
        maxBytes: 64 * 1024 * 1024,
        maxEntryBytes: 512 * 1024,
      },
    },
  ],
});
```

```bash
curl -i http://127.0.0.1:3000/catalog/items
# x-cache: MISS
curl -i http://127.0.0.1:3000/catalog/items
# x-cache: HIT
# Age: 0
```

Responses with `Authorization`, `Cookie`, `Range`, `Set-Cookie`, `no-store`, `private` or `no-cache` are never stored; unsafe methods purge the same pathname. See [response caching](caching.md) for TTL/Vary rules, memory budgets, coalescing and multi-replica caveats.

## 14. Runtime control: drain, weight and route reload

`RouteBalancerService` exposes operational controls without restarting the process. No admin endpoint is created automatically; expose it behind your own authentication and network policy.

```ts
import { Body, Controller, NotFoundException, Post, UseGuards } from "@nestjs/common";
import { RouteBalancerService, type RouteOptions } from "nestjs-balancer";
import { InternalAdminGuard } from "./internal-admin.guard";

@Controller("_internal/balancer")
@UseGuards(InternalAdminGuard)
export class BalancerAdminController {
  constructor(private readonly balancer: RouteBalancerService) {}

  @Post("reload")
  reload(@Body() body: { routes: RouteOptions[] }) {
    return this.balancer.reloadRoutes({ ...this.balancer.options, routes: body.routes });
  }

  @Post("drain")
  drain(@Body() body: { path: string; upstream: string }) {
    if (!this.balancer.drainUpstream(body.path, body.upstream)) {
      throw new NotFoundException("Unknown route path or upstream");
    }
    return { drained: true };
  }

  @Post("resume")
  resume(@Body() body: { path: string; upstream: string }) {
    if (!this.balancer.resumeUpstream(body.path, body.upstream)) {
      throw new NotFoundException("Unknown route path or upstream");
    }
    return { drained: false };
  }

  @Post("weight")
  weight(@Body() body: { path: string; upstream: string; weight: number }) {
    if (!this.balancer.setUpstreamWeight(body.path, body.upstream, body.weight)) {
      throw new NotFoundException("Unknown route path or upstream");
    }
    return { weight: body.weight };
  }
}
```

```bash
# Rolling deploy: stop sending new traffic to one instance.
curl -X POST http://gateway.internal:3000/_internal/balancer/drain \
  -H 'authorization: Bearer $ADMIN_TOKEN' -H 'content-type: application/json' \
  -d '{"path":"/api","upstream":"http://10.0.0.11:8080"}'

# Rebalance a canary before reloading the route table.
curl -X POST http://gateway.internal:3000/_internal/balancer/weight \
  -H 'authorization: Bearer $ADMIN_TOKEN' -H 'content-type: application/json' \
  -d '{"path":"/api","upstream":"http://10.0.0.12:8080","weight":4}'

# Replace the route table atomically; invalid input leaves the current table untouched.
curl -X POST http://gateway.internal:3000/_internal/balancer/reload \
  -H 'authorization: Bearer $ADMIN_TOKEN' -H 'content-type: application/json' \
  -d '{"routes":[{"path":"/api","upstreams":["http://10.0.0.11:8080","http://10.0.0.12:8080"]}]}'
# -> {"added":[],"removed":[],"updated":["/api"]}
```

Behavior:

- `drainUpstream` only stops **new** selections; in-flight requests finish normally and `active` drains to zero. `resumeUpstream` does not reset circuit or ejection state.
- `setUpstreamWeight` accepts integers `1..1000` and throws on invalid values. The configured weight wins on the next reload, so persist runtime changes or reload from the same source that produced them.
- `reloadRoutes` accepts a full `RouteBalancerOptions` value. It validates everything first, swaps the table atomically and returns `{ added, removed, updated }`.
- `trustProxy`, `maxSockets`, `keepAlive`, `shutdownTimeoutMs`, `ssrf` and `requestInterception` are bootstrap-only; changing them throws.
- State (counters, EWMA, circuit, drain flag) is carried only for the same route path **and** upstream origin. Requests already in flight keep using the previous snapshot and their completion is not counted in the new table.
- Health-check and outlier timers are rebuilt for the reloaded routes.
- Runtime changes are process-local: with several replicas, apply the same operation to each instance and keep your orchestrator as the source of truth.

## Common mistakes

| Symptom | Cause / fix |
| --- | --- |
| `POST` body arrives empty upstream | Body parsing enabled. Create Nest with `{ bodyParser: false }` and do not add `json()`/`urlencoded()` middleware for proxied routes. |
| `421 Misdirected request` | `allowedHosts` does not match the client `Host`, or the host is malformed. |
| `503 No healthy upstream available` | All upstreams are open-circuit, ejected, bulkheaded, or named-but-unknown strategy rejected at startup. Check active health checks and logs. |
| Client gets `502` after a large upload | A timeout or upstream socket limit stopped the stream. Tune `requestTimeoutMs`, `maxSockets` and the upstream's own limits. |
| `403/500` from the admin controller example | Add your own guard and authentication; the library never exposes runtime controls automatically. |
| `x-cache` stays `MISS` for every request | The response is not storable: `Set-Cookie`, `no-store`/`private`/`no-cache`, a `Vary` header not listed in `cache.vary`, a status outside `statuses`, or a body above `maxEntryBytes`. |
| Stale data after a write on another replica | Caches are process-local; invalidate at the edge or shorten `ttlMs`. |
| All clients receive `429` at the same moment | The bucket is shared and exhausted (for example `perRoute: false` or an empty header key falling back to one ingress address). Check the key source and limits. |
| Effective limit is higher than configured | Every replica enforces its own process-local bucket. Use a shared edge/Redis limiter for a global quota. |
| Runtime weight resets after a deploy/reload | Configured weights win on reload; persist the desired weights in your configuration source. |
| Sticky sessions reset after restart | No shared `sticky.secret`; each process signs with a random secret. |
| `INVALID requestInterception.exposedHeaders` at bootstrap | Protected headers (`host`, `x-forwarded-*`, `x-request-id`, framing headers) cannot be exposed or edited by plugins. |
| Proxy request id changes unexpectedly | Client `x-request-id` must be 1–128 visible ASCII characters; otherwise the gateway generates a new one. |
| Synthetic errors cached by a CDN | Gateway errors are sent with `Cache-Control: no-store`, but check intermediary configuration as well. |
