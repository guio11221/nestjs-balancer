# Changelog

## 0.9.0

- Added opt-in per-route `cache` for `GET`/`HEAD`: TTL storage with `s-maxage`/`max-age` caps, configurable cacheable statuses, `accept-encoding` plus configured `Vary` keys, per-route LRU `maxEntries`/`maxBytes` budgets and `maxEntryBytes` streaming fallback.
- Safe-by-default storage: `Authorization`, `Cookie`, `Range`, client `no-cache`/`no-store`, `Set-Cookie`, `no-store`/`private`/`no-cache` responses, `Vary: *` and unconfigured `Vary` names are never cached.
- Added single-flight coalescing for concurrent misses (bounded by `requestTimeoutMs`), `x-cache: MISS|HIT|BYPASS`, `Age` and `x-request-id` on hits.
- Unsafe methods invalidate the same pathname; `reloadRoutes` clears the cache; new `clearCache(routePath?)`; cache hits remain rate-limited and pass through plugins.
- Added per-route `cacheHits`/`cacheMisses`/`cacheStores` metrics and `route_balancer_route_cache_*_total` Prometheus counters.
- Added `docs/guides/caching.md` and updated the configuration reference, architecture invariants, security/testing guidance and documentation index.
- Added unit tests for keys, expiry, LRU/byte budgets, oversize rejection, invalidation, coalescing and validation, plus integration tests for hits/misses/bypass, Vary variants, TTL expiry, request coalescing, HEAD entries and invalidation.

## 0.8.0

- Added optional local rate limiting per route: `rateLimit: { limit, windowMs, key, header, perRoute, maxKeys }` with a lazy-refill token bucket, per-client identity by peer address or header and LRU-bounded memory.
- Accepted requests receive `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; rejections receive `429`, `Retry-After`, `Cache-Control: no-store` and never reach plugins or upstreams.
- Added `RouteBalancerService.checkRateLimit` and `resetRateLimits`; route reloads clear buckets, and `rateLimited` is exposed in metrics plus `route_balancer_route_rate_limited_total` in Prometheus.
- Documented request limits, identity spoofing caveats, multi-replica behavior and memory bounds.
- Reorganized `docs/` into `guides/`, `reference/` and `operations/` with a [documentation index](docs/README.md); added a complete [configuration reference](docs/reference/configuration.md) and a [rate-limiting guide](docs/guides/rate-limiting.md), and updated links in the README, AGENTS.md and skills.
- Added unit tests for bucket math, identity isolation, `maxKeys` eviction, `trustProxy` and validation, plus integration tests for headers, `429`, header fallback and reload resets.

## 0.7.0

- Added runtime control to `RouteBalancerService`: `drainUpstream`/`resumeUpstream` exclude and restore an upstream without cancelling in-flight requests, and `setUpstreamWeight` changes selection weights (`1..1000`) at runtime.
- Added atomic `reloadRoutes(options)`: full validation before the swap, a `{ added, removed, updated }` diff, route-table replacement, health/outlier timer rebuild and rejection of bootstrap-only option changes (`trustProxy`, `maxSockets`, `keepAlive`, `shutdownTimeoutMs`, `ssrf`, `requestInterception`).
- Reloads carry counters, EWMA latency, circuit/ejection state and drain flags for the same route path + origin; in-flight requests finish on the previous snapshot and moving an upstream to another route starts fresh state.
- Added the `drained` upstream gauge (`UpstreamState.drained`) and the `route_balancer_upstream_drained` Prometheus metric.
- Added unit and integration coverage for draining, all-drained `503`, runtime weights, reload diffs/atomicity/static-option rejection, state carry-over and in-flight reloads.
- Documented the runtime admin surface, caveats and guard requirements in the README, `docs/EXAMPLES.md`, `docs/METRICS.md` and the architecture invariants.

## 0.6.1

- Forwarded headers are now built by one shared helper used by the HTTP/1 proxy and the WebSocket transport: empty `X-Forwarded-For` entries no longer produce a leading comma, and `X-Forwarded-Host` is omitted when the client sent no `Host` (HTTP/1.0).
- Client `x-request-id` values are validated (1–128 visible ASCII characters) before being forwarded or echoed; malformed and oversized values are replaced with a generated id.
- Adaptive metrics now record per-attempt latency instead of total request time, so retries and backoff no longer blame the successful upstream.
- Synthetic gateway errors now carry `Content-Length` and `Cache-Control: no-store`; shutdown `503` responses send `Connection: close`, which also fixes chunked responses to HTTP/1.0 clients.
- Added unit tests for forwarding-header construction and integration tests for request-id validation, HTTP/1.0 forwarding, error framing, per-attempt latency, HEAD/204 passthrough, `changeOrigin` and strip-prefix boundaries.
- Added `docs/EXAMPLES.md` with end-to-end recipes, a metrics/Prometheus setup and a troubleshooting table.

## 0.6.0

- Added the `peak-ewma` strategy: every eligible upstream is scored by decayed EWMA latency × (1 + active) ÷ weight.
- Added the `p2c` (power of two choices) strategy: samples two random upstreams and keeps the better score.
- Added 10-second latency decay driven by the new `ewmaObservedAt` upstream field, which `recordLatency()` now stamps.
- Untried upstreams score neutral so they receive a warm-up request; score ties fall back to normalized load and rotation.
- Added unit tests for scoring, in-flight penalties, decay, tie-breaking and record timestamps.
- Fixed the plugin integration test, which exposed the protected `x-request-id` header and aborted the NestJS process during bootstrap.
- `npm run check` passes with 103 tests (60 unit, 33 integration, 10 transport) on Node.js 24.15.0/Windows.

## 0.5.0

- Added connect/headers/whole-request/idle timeout policies; `0` disables a timer.
- Added signed opaque sticky sessions with configurable TTL and a process-wide secret.
- Added consecutive-5xx outlier ejection with interval-based decay; transport failures still drive the circuit breaker.
- Added retry classification (`retryOn`), capped exponential backoff and a rolling retry budget (`maxRetryRate`).
- Added `allowedHosts` host filtering, graceful shutdown draining (`shutdownTimeoutMs`) and bounded request windows.
- Hardened SSRF checks for IPv6 literals, IPv4-mapped addresses, loopback and link-local ranges.
- Reworked consistent hashing to use a weighted virtual-node ring with stable key remapping.
- Reused HTTP/2 sessions per origin, released WebSocket upstreams on rejected handshakes and added upgrade idle timeouts.
- Added `retries`/`consecutive5xx` Prometheus counters and regression tests for all new behavior.
- Added a real NestJS bootstrapping integration test for module wildcard registration.
- Updated documentation and package metadata; 60 tests pass under `npm run check`.

## 0.4.0 (experimental)

- Added opt-in HTTP/1.1 WebSocket Upgrade socket tunneling.
- Added Fastify raw-request hook integration helper.
- Added isolated experimental h2c-to-h2c transport.
- Added Prometheus exposition formatter.
- Added protocol regression tests, security/compatibility documentation, and a transport development skill.

## 0.3.0 (development preview)

- Hardened HTTP response-stream lifecycle, delayed success recording to response completion.
- Safer forwarding-header handling; removed untrusted RFC 7239 `Forwarded` values.
- Prevented overlapping active health probes for the same route and upstream.
- Reject configuration that requests unsafe/malformed retry methods.
- Added failure, transport cancellation, circuit recovery and header security integration tests.
- Added architecture, security, test documentation and dedicated proxy/test agent skills.

## 0.2.0

- Smooth Weighted Round Robin and weighted Least Connections tie handling.
- Extensible custom strategy registry.
- HTTP and HTTPS keep-alive agents with max sockets configuration.
- Passive circuit-breaker recovery/cooldown and success/failure accounting.
- Optional bounded retries for bodyless GET/HEAD requests only.
- Real HTTP integration tests, fixed CI structure, expanded documentation and development skills.

## 0.1.0

- Initial Express HTTP reverse proxy, route balancing and health checks.
