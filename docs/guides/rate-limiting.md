# Rate limiting

The balancer can enforce a **local token bucket per route and client**. It runs after route/Host validation and before request plugins or upstream selection, so rejected requests never touch a backend, a plugin or a retry.

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

This allows bursts up to `limit` requests, then sustains roughly `limit / windowMs` requests per millisecond until the bucket refills. It is not a fixed window: there is no reset cliff and no burst amplification at window boundaries.

## Configuration

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | `number` | required | Bucket capacity; positive integer. |
| `windowMs` | `number` | required | Time to refill from empty to full; minimum `10`. |
| `key` | `'ip' \| 'header'` | `'ip'` | Client identity source. |
| `header` | `string` | unset | Required when `key: 'header'`; valid header token. |
| `perRoute` | `boolean` | `true` | Scope buckets by route path. |
| `maxKeys` | `number` | `10000` | Live buckets kept in memory; least recently used evicted first. |

### Per client address (default)

```ts
rateLimit: { limit: 60, windowMs: 60_000 }
```

One bucket per `route path + client address`. With `trustProxy: false` the address is the TCP peer; with `trustProxy: true` the first `X-Forwarded-For` entry is used, which is only meaningful when a trusted ingress sanitizes that header.

### Per API key or tenant header

```ts
rateLimit: {
  limit: 1000,
  windowMs: 60_000,
  key: "header",
  header: "x-api-key",
  maxKeys: 50_000,
}
```

Requests without the header fall back to the peer address, so omitting a key never grants unlimited traffic. Header values are trimmed and truncated to 256 characters for memory safety.

### Shared bucket across routes

```ts
rateLimit: { limit: 500, windowMs: 60_000, perRoute: false }
```

`perRoute: false` keys by client only. Configuring different limits on routes that share a bucket is allowed but confusing: the bucket keeps the capacity/refill of whichever configuration created it until it is evicted, reset or reloaded. Prefer one limit per shared identity.

## Response headers

Accepted requests receive:

| Header | Meaning |
| --- | --- |
| `RateLimit-Limit` | Bucket capacity. |
| `RateLimit-Remaining` | Whole tokens left. |
| `RateLimit-Reset` | Seconds until the bucket is full again. |

Rejected requests receive `429` with the same headers plus `Retry-After` (seconds until one token is available), a JSON body and `Cache-Control: no-store`:

```json
{ "statusCode": 429, "message": "Rate limit exceeded" }
```

Upstream-supplied `RateLimit-*` headers are replaced by the gateway values, because the gateway is the enforcement point.

## Operational behavior

- **Memory:** one small bucket object per client; `maxKeys` bounds the map and evicts the least recently used key. A client that disappears stops occupying memory once evicted.
- **Reloads:** `reloadRoutes` clears every bucket because limits may have changed. `resetRateLimits()` clears them on demand (useful after an administrative change or during incident response).
- **Metrics:** `service.metrics().routes[n].rateLimited` counts rejected requests per route; Prometheus exposes `route_balancer_route_rate_limited_total{route="..."}`.
- **Errors and retries:** a `429` is generated before upstream acquisition; it does not increment upstream counters and is never retried.
- **Multiple replicas:** each process enforces its own bucket, so the effective limit is roughly `limit × replicas`. Use a shared rate limiter at the edge or in Redis when a global quota is required. This module intentionally does not implement distributed limiting.

## Admin reset

```ts
@Controller("_internal/balancer")
@UseGuards(InternalAdminGuard)
export class BalancerAdminController {
  constructor(private readonly balancer: RouteBalancerService) {}

  @Post("rate-limits/reset")
  reset(): { reset: true } {
    this.balancer.resetRateLimits();
    return { reset: true };
  }
}
```

Protect this endpoint like any other runtime control; resetting buckets lets clients regain their full burst immediately.

## Choosing limits

- Size `limit` for the burst you can absorb, not for average traffic. A common starting point is `20%` of expected peak requests per minute for `windowMs: 60_000`.
- Keep `maxKeys` comfortably above the number of distinct clients in a window; each entry is a few dozen bytes, but the map is per process.
- Combine with `bulkhead` for backend protection: the rate limit shapes client traffic, the bulkhead protects upstream concurrency.
- Watch `rate_limited_total`; a sustained non-zero rate means either abusive clients or limits set below real usage.
- Do not use this as authentication. It limits volume, not identity: the header key is client-controlled unless your ingress validates it.

## Related

- [Configuration reference](../reference/configuration.md#route-options)
- [Security checklist](../operations/security-hardening.md)
- [Architecture invariants](../reference/architecture.md)
