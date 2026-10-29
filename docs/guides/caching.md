# Response caching

The balancer can cache complete `GET`/`HEAD` responses in process and serve them without contacting an upstream. Caching is **opt-in per route** and designed to be safe by default: authenticated, cookie-bearing, ranged, `no-store`, `private` and `Set-Cookie` traffic is never stored or reused.

```ts
RouteBalancerModule.forRoot({
  routes: [
    {
      path: "/catalog",
      upstreams: ["http://10.0.0.11:8080", "http://10.0.0.12:8080"],
      cache: {
        ttlMs: 30_000,
        maxEntries: 2_000,
        maxBytes: 64 * 1024 * 1024,
        maxEntryBytes: 512 * 1024,
        vary: ["accept-language"],
        statuses: [200, 404],
      },
    },
  ],
});
```

## Configuration

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `ttlMs` | `number` | required | Maximum serving time; capped by upstream `s-maxage`/`max-age`. |
| `statuses` | `number[]` | `[200, 203, 204, 301, 308]` | Only these upstream statuses are stored. |
| `vary` | `string[]` | `[]` | Extra request headers in the cache key. `accept-encoding` is always included. |
| `maxEntries` | `number` | `1000` | Stored variants per route; least recently used evicted first. |
| `maxBytes` | `number` | `50 MiB` | Stored **body** bytes per route. |
| `maxEntryBytes` | `number` | `1 MiB` | Responses above this stream through uncached. |

## What is stored

A response is stored only when all of these are true:

- request is `GET` or `HEAD` and has no `Authorization`, `Cookie` or `Range` header;
- request `Cache-Control` is not `no-cache`/`no-store`;
- upstream status is in `statuses`;
- response has no `Set-Cookie`, `Cache-Control: no-store|private|no-cache`;
- response `Vary` is absent, or only names headers already in the key (`accept-encoding` plus configured `vary`);
- response body is not larger than `maxEntryBytes`.

Everything else is streamed uncached. When the request is cache-eligible but the response is not storable, the response carries `x-cache: BYPASS`. Requests that bypass the cache at the request level (`Authorization`, `Cookie`, `Range`, client `no-cache`) carry no `x-cache` header at all.

## Cache key and variants

The key is `route + method + pathname + query + vary values`. `accept-encoding` is always part of it so compressed variants never mix. `GET` and `HEAD` never share entries.

Because response `Vary` names must be configured in advance, an upstream that varies on a header you did not list will simply not be cached — it will not be served incorrectly.

## TTL

`ttlMs` is an upper bound. `Cache-Control: s-maxage`/`max-age` can only shorten it; `max-age=0`, `no-cache`, `no-store` and `private` prevent storage. The clock starts when the response finishes streaming.

## Response headers

| Header | Meaning |
| --- | --- |
| `x-cache: MISS` | Forwarded to the upstream and stored (or eligible to be stored). |
| `x-cache: HIT` | Served from the local cache. |
| `x-cache: BYPASS` | Request was cache-eligible but the upstream response was not storable. |
| `Age` | Seconds since the cached response was stored (hits only). |
| `RateLimit-*` | Gateway rate-limit values, including on hits. |

`x-request-id` is always regenerated per request; upstream values are not reused.

## Invalidation

- **Unsafe methods:** `POST`, `PUT`, `PATCH`, `DELETE` and any other non-`GET`/`HEAD` request through a cache-enabled route purges cached variants for the **same pathname** (all queries/methods) before proxying.
- **Runtime reload:** `reloadRoutes` clears the whole cache because limits and route shapes may have changed.
- **Administrative purge:** `service.clearCache()` clears everything; `service.clearCache("/catalog")` clears one route.

There is no cross-replica invalidation. When several replicas serve the same data, a write only invalidates the replica that handled it; keep TTLs short or purge through the CDN / shared cache layer.

## Streaming and concurrency

- Responses still stream to the client; the proxy keeps a bounded copy in memory until the body finishes. When `maxEntryBytes` is exceeded, the copy is dropped and streaming continues.
- Concurrent misses for the same key are **coalesced**: one request fills the cache, the others wait up to `timeouts.requestTimeoutMs`, then re-check. If the leader fails or the wait times out, followers proceed to the upstream normally.
- Cache hits are served instantly, but only after rate limiting and the plugin chain, so tenant/auth rewrites and rejections apply before a hit is returned.

## Memory and metrics

Each variant stores its body, sanitized headers and metadata. Budgets are per route: `maxEntries` and `maxBytes`; expired entries are removed on read and before writes. `service.metrics().routes[n]` reports `cacheHits`, `cacheMisses` and `cacheStores`; Prometheus exposes:

- `route_balancer_route_cache_hits_total`
- `route_balancer_route_cache_misses_total`
- `route_balancer_route_cache_stores_total`

## What this cache is not

- Not a CDN: it is process-local, in-memory and lost on restart.
- Not a shared cache: replicas do not share entries or invalidations.
- Not a Stale-While-Revalidate implementation; expired entries are simply dropped.
- Not for personal data: requests with `Authorization` or `Cookie` bypass it by design.
- Range requests are never served from cache.

For multi-tenant or geographically distributed traffic, terminate caching at the edge and use this as a per-replica burst absorber.

## Related

- [Configuration reference](../reference/configuration.md#route-options)
- [Rate limiting](rate-limiting.md)
- [Metrics](metrics.md)
- [Architecture](../reference/architecture.md)
