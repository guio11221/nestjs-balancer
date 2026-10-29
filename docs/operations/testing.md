# Testing strategy

## Commands

```bash
npm install
npm run check
npm run pack:check
```

`npm run check` performs typechecking, compilation, unit tests, HTTP/NestJS integration tests and transport tests using ephemeral `127.0.0.1` ports. There are no public endpoints or API keys; the integration tests use only NestJS/TypeScript/Express development dependencies.

## Coverage matrix

| Layer | Expected invariants |
|---|---|
| Nest module and plugins | wildcard middleware registration, real Nest/Express bootstrap, `forRoot`/`forRootAsync` provider injection, plugin order/isolation, bounded in-route path rewrite, allowlisted headers, reject/throw/timeout/cancel fail-closed behavior |
| Configuration | malformed routes, duplicates, unsupported URL schemes, invalid weights, retry limits, timeout/ssrf/sticky validation |
| Strategy | cyclic, smooth weighted, least connections, consistent-hash stability, custom strategy guard, adaptive peak-EWMA/P2C scoring, in-flight penalty, latency decay and warm-up of untried upstreams |
| Proxy | method, body, query string, streaming, hop-by-hop headers, forwarded headers, Host allowlist; request-id validation and replacement; HTTP/1.0 without Host omits `X-Forwarded-Host`; synthetic error framing (`Content-Length`, `no-store`, shutdown `Connection: close`); per-attempt latency; HEAD/204 passthrough; `changeOrigin`; strip-prefix boundary and encoded queries; plugin path/header mutations must preserve method/body/query/upstream and not cross route boundaries |
| Resilience | connect/headers/idle/whole-request timeout, GET failover, no POST replay, retry policy/budget, open/half-open/recovered circuit, 5xx outlier ejection |
| Sticky | opaque signed cookie, tamper/empty/expired rejection, cookie merge |
| Lifecycle | release active counters, cleanup on abort, shutdown draining, destroy agents and timers |
| Rate limit | token bucket allows the configured burst and refills deterministically; keys by address/header with fallback; per-route isolation and shared buckets; `maxKeys` eviction; `trustProxy` identity; `RateLimit-*`/`Retry-After` headers; `429` never reaches the upstream; metrics counter; reset and reload clear buckets; validation of limit/window/key/header/maxKeys |
| Cache | hit/miss/bypass via `x-cache`, `Age`, variant keys with `accept-encoding`/configured `Vary`, TTL expiry, LRU entry/byte budgets, `maxEntryBytes` streaming fallback, coalesced concurrent misses, unsafe-method invalidation, authorization/cookie/Range/client-`no-cache` bypass, HEAD entries and validation |
| Runtime control | drain excludes without cancelling in-flight work and resumes; all-drained returns `503`; weights validate and change WRR distribution; reload diffs added/removed/updated, rejects invalid input atomically and bootstrap-only option changes, carries state only for the same route path + origin, keeps in-flight requests on the previous snapshot, and rebuilds health/outlier timers |
| Transports | HTTP/2 session reuse, WebSocket tunnel/rejection/idle timeout |

## Plugin security test matrix

- Verify plugin providers are resolved through the module's own Nest injector for both synchronous and asynchronous module registration; importing multiple balancer modules must not share a global plugin registry.
- Assert plugin order and that later plugin decisions see only the original frozen request snapshot, not earlier mutations.
- Assert sensitive/protected headers are absent unless safe headers are explicitly exposed; protected names are never exposable. Plugin-added headers require the allowlist and reject all C0/DEL controls, invalid token names, protected headers and oversized values.
- Assert path rewriting preserves the query and cannot escape the originally matched route using slash boundaries, `..`, encoded separators, percent-encoded octets, malformed encodings, protocol-relative paths or control characters.
- Assert method/body/upstream stay unchanged; plugin reject, throw, malformed decision and timeout make zero upstream requests.
- Assert client disconnect and application shutdown abort the plugin signal, clear timers/listeners, and release lifecycle tracking exactly once; verify shutdown drains active request bookkeeping.
- Use a never-settling promise for timeout tests; bound wall-clock assertions with generous CI tolerance and verify `signal.aborted`.

## Additional preproduction tests

Run application-level tests with actual NestJS controllers, test with NGINX/Envoy frontends, benchmark with `autocannon` or `wrk` against representative payloads and keep-alive profiles, run fault injection with slow/fragmented response streams, and perform protocol security reviews. The current suite is a regression baseline, not proof of production reliability.
