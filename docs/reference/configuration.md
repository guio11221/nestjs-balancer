# Configuration reference

All configuration is validated at construction time (and again on every `reloadRoutes`). Invalid input throws before the gateway starts; invalid reloads leave the previous table untouched.

```ts
RouteBalancerModule.forRoot(options, plugins?);
RouteBalancerModule.forRootAsync({ imports?, inject?, useFactory, plugins? });
```

## Global options

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `routes` | `RouteOptions[]` | required | Absolute path prefixes. Duplicates are rejected. |
| `trustProxy` | `boolean` | `false` | When true, client `X-Forwarded-*` is preserved and the balancer appends the peer. Only enable behind a trusted ingress. |
| `keepAlive` | `boolean` | `true` | TCP keep-alive for upstream agents. |
| `maxSockets` | `number` | `128` | Per-origin socket cap for the HTTP/HTTPS agents. |
| `shutdownTimeoutMs` | `number` | `10000` | Maximum drain time before aborting in-flight requests. |
| `ssrf` | `SsrfOptions` | see below | Upstream URL policy, applied when routes are validated. |
| `requestInterception` | `RequestInterceptionOptions` | `{}` | Plugin chain timeout and header allowlists. |

`trustProxy`, `maxSockets`, `keepAlive`, `shutdownTimeoutMs`, `ssrf` and `requestInterception` are **bootstrap-only**: `reloadRoutes` rejects changes to them.

### `ssrf`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `allowPrivate` | `boolean` | `true` | Allows RFC 1918/private ranges. Set `false` for internet-facing gateways. |
| `allowLocalhost` | `boolean` | equals `allowPrivate` | Allows loopback targets. An explicit `false` overrides `allowPrivate`. |
| `allowLinkLocal` | `boolean` | unset (blocked) | Allows link-local targets (includes metadata endpoints). Independent of `allowPrivate`; an explicit `true` is required. |
| `allowlist` | `string[]` | unset | Exact hosts or `*.suffix` entries; when present, everything else is rejected. `*.suffix` also matches the suffix itself. |
| `blocklist` | `string[]` | unset | Exact hosts or `*.suffix` entries rejected before the allowlist. |

### `requestInterception`

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `timeoutMs` | `number` | `1000` | Whole plugin chain; `1..30000`. |
| `exposedHeaders` | `string[]` | `[]` | Request headers visible to plugins. |
| `allowedHeaders` | `string[]` | `[]` | Headers plugins may add, replace or remove. |

Protected headers (`host`, framing, hop-by-hop, `forwarded`, `x-forwarded-*`, `x-request-id`) cannot appear in either list. At most 32 plugins are accepted.

## Route options

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `path` | `string` | required | Must start with `/`; matched on exact path or `/` boundary; longest prefix wins. |
| `upstreams` | `Array<string \| {url, weight?}>` | required | HTTP(S) origins only, no credentials/path/query. Weight `1..1000`, default `1`. |
| `strategy` | `BalancingStrategy` | `'round-robin'` | Built-ins: `round-robin`, `weighted-round-robin`, `least-connections`, `least-response-time`, `peak-ewma`, `p2c`, `random`, `consistent-hash`, or a registered custom name. |
| `hashKey` | `'ip' \| 'path' \| 'header' \| string` | `'ip'` | Used by `consistent-hash`. |
| `hashHeader` | `string` | unset | Required for `hashKey: 'header'`. |
| `timeoutMs` | `number` | `30000` | Fallback for the granular timers below. |
| `timeouts` | `TimeoutsOptions` | see below | `0` disables a timer. |
| `stripPrefix` | `boolean` | `false` | `/api/users` with route `/api` reaches the upstream as `/users`. |
| `changeOrigin` | `boolean` | `true` | Rewrites the upstream `Host` header. |
| `allowedHosts` | `string[]` | unset | Exact or `*.suffix`; mismatches return `421`. HTTP/1 only. |
| `retry` | `RetryOptions` | disabled | Bodyless `GET`/`HEAD`, pre-response failures only. |
| `circuitBreaker` | `CircuitBreakerOptions` | defaults active | Passive transport-failure circuit. |
| `bulkhead` | `BulkheadOptions` | unset | Concurrency caps per upstream/route. |
| `rateLimit` | `RateLimitOptions` | unset | Local token bucket. See [rate limiting](../guides/rate-limiting.md). |
| `cache` | `CacheOptions` | unset | Opt-in `GET`/`HEAD` response cache. See [caching](../guides/caching.md). |
| `outlierDetection` | `OutlierDetectionOptions` | disabled | Ejects an upstream after consecutive `5xx`. |
| `sticky` | `StickyOptions` | disabled | Signed opaque session cookie. |
| `healthCheck` | `HealthCheckOptions` | disabled | Active probes; also recovers open circuits. |
| `onRequestComplete` | `(event) => void` | unset | Synchronous callback after a successful upstream stream ends. Exceptions are swallowed. |

### `timeouts`

| Field | Default | Covers |
| --- | --- | --- |
| `connectTimeoutMs` | `min(timeoutMs, 5000)` | Connection establishment (new sockets only). |
| `headersTimeoutMs` | `timeoutMs` | Time until upstream response headers. |
| `requestTimeoutMs` | `timeoutMs` | Whole attempt, including the response body. |
| `idleTimeoutMs` | `timeoutMs` | Inactivity between response bytes. |

### `retry`

| Field | Type / default | Notes |
| --- | --- | --- |
| `attempts` | `0` (0–10) | Extra attempts after the first. |
| `methods` | `['GET','HEAD']` | Only these methods are accepted; anything else throws. |
| `retryOn` | all reasons | Subset of `network`, `timeout`, `connect`. |
| `backoffMs` | `25` | Exponential base. |
| `jitterMs` | `0` | Symmetric jitter around the computed backoff. |
| `maxBackoffMs` | `30000` | Cap for the computed delay. |
| `maxRetryRate` | unset | Rolling 60s retry budget as a fraction of requests (`0..1`); `0` disables retries. |

Requests with `content-length` or `transfer-encoding` are never replayed, and `5xx` responses do not trigger retries.

### `circuitBreaker`

| Field | Default | Notes |
| --- | --- | --- |
| `failureThreshold` | `1` | Failures needed (consecutive or in-window, see below). |
| `cooldownMs` | `10000` | Open period before a half-open probe. |
| `slidingWindowSize` | unset | Seconds; when set, failures are counted in a sliding window instead of consecutively. |
| `minimumRequests` | `1` | Minimum requests in the window before opening. |
| `maxHalfOpen` | `1` | Concurrent half-open probes. |

### `bulkhead`

| Field | Default | Notes |
| --- | --- | --- |
| `maxConcurrentPerUpstream` | unset | Excess requests skip that upstream. |
| `maxConcurrentPerRoute` | unset | Excess requests receive `503`. |

### `outlierDetection`

| Field | Default | Notes |
| --- | --- | --- |
| `consecutive5xx` | required | Threshold that enables ejection. |
| `intervalMs` | `30000` | Decay interval for the ejection count (minimum `100`). |
| `baseEjectionTimeMs` | `30000` | Ejection grows with repeated ejections (minimum `1000`). |

### `cache`

| Field | Default | Notes |
| --- | --- | --- |
| `ttlMs` | required | Upper bound; capped by `s-maxage`/`max-age`. |
| `statuses` | `[200, 203, 204, 301, 308]` | Cacheable upstream statuses. |
| `vary` | `[]` | Extra request headers in the key; `accept-encoding` is always included. |
| `maxEntries` | `1000` | Variants per route, LRU eviction. |
| `maxBytes` | `52428800` | Stored body bytes per route. |
| `maxEntryBytes` | `1048576` | Larger responses stream through uncached. |

Authenticated, cookie-bearing, ranged and `no-store`/`private` traffic is never stored. Unsafe methods purge the same pathname; `reloadRoutes` clears the cache.

### `sticky`

| Field | Default | Notes |
| --- | --- | --- |
| `cookie` | required | Cookie name. |
| `ttlMs` | `3600000` | `0` makes a session cookie with no expiry check. |
| `secure` | `false` | Adds `Secure`. |
| `httpOnly` | `true` | Set `false` only for browser APIs that must read the token. |
| `sameSite` | unset | `strict`, `lax` or `none`. |
| `secret` | process-local random | Required for multiple replicas; tokens are HMAC-signed. |

### `healthCheck`

| Field | Default | Notes |
| --- | --- | --- |
| `path` | required | Must be an absolute path within the upstream origin. |
| `intervalMs` | required | Minimum `100`. |
| `timeoutMs` | `2000` | Per-probe timeout. |
| `expectedStatus` | `2xx`/`3xx` | Any non-empty list of `100..599`. |
| `method` | `GET` | Upper-case token; `CONNECT` is rejected. |
| `headers` | unset | Static headers; CR/LF rejected. |

## Error responses

Synthetic gateway responses are JSON with `Content-Length`, `Cache-Control: no-store` and `x-request-id`:

| Status | Meaning |
| --- | --- |
| `400` | Malformed request URL or plugin path rewrite. |
| `421` | `allowedHosts` mismatch or malformed `Host`. |
| `429` | Local rate limit exceeded; includes `RateLimit-*` and `Retry-After`. |
| `502` | Upstream transport failure, incomplete stream or no remaining healthy upstream. |
| `503` | Shutting down, no healthy upstream, or route bulkhead saturated. |
| `504` | Plugin chain timeout. |

## Runtime controls

| Method | Returns | Notes |
| --- | --- | --- |
| `drainUpstream(path, url)` | `boolean` | Excludes from new selection; in-flight requests finish. |
| `resumeUpstream(path, url)` | `boolean` | Re-enables a drained upstream. |
| `setUpstreamWeight(path, url, weight)` | `boolean` | Integer `1..1000`; throws on invalid weights. |
| `reloadRoutes(options)` | `{ added, removed, updated }` | Atomic; validates first; carries state per route path + origin. |
| `resetRateLimits()` | `void` | Clears every local rate-limit bucket. |
| `clearCache(routePath?)` | `void` | Clears one route's cache or all entries. |
| `metrics()` | `BalancerMetrics` | Process-local snapshot. |

`path` must match the configured route exactly; `url` is normalized to its origin. Reloads restart health/outlier timers and clear rate-limit buckets. See [examples](../guides/examples.md#14-runtime-control-drain-weight-and-route-reload).

## Validation rules worth knowing

- Route paths are normalized by removing trailing slashes; duplicates throw.
- Upstream URLs must be origins: no credentials, path, query, fragment or non-HTTP(S) scheme.
- `timeouts` and `healthCheck` values must be finite and within their minimums.
- Plugin header lists and health-check headers reject CR/LF and protected names.
- Plugin path rewrites must stay inside the matched route and preserve the query.
- `retry.methods` accepts only `GET` and `HEAD`.

## Related

- [Rate limiting guide](../guides/rate-limiting.md)
- [Architecture invariants](architecture.md)
- [Metrics](../guides/metrics.md)
- [Security checklist](../operations/security-hardening.md)
