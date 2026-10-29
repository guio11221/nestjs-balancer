# Architecture

## Request path

```text
Nest HTTP/1 Express request
  -> RouteBalancerMiddleware (match longest configured prefix, validate Host)
  -> local rate limit (token bucket; 429 before plugins and upstreams)
  -> ordered NestJS request plugins (immutable/redacted context, bounded timeout)
  -> apply route-contained pathname + allowlisted header changes, or reject
  -> local cache lookup for GET/HEAD (serve hit or coalesce a miss)
  -> RouteBalancerService.acquire (filter unhealthy/open-circuit/drained/attempted nodes)
  -> selectUpstream (pluggable strategy)
  -> HTTP/1.1 upstream transport (native Node HTTP(S) and keep-alive agent)
  -> streamed downstream response
  -> RouteBalancerService.success/failure + release
```

**Principle:** selection, health state, configuration, and transport are separate concerns. The middleware never owns the upstream registry; the service owns all per-instance lifecycle state.

## Invariants

1. An upstream must be a validated HTTP(S) origin, without embedded credentials, path or query.
2. Route paths match only exact path or slash boundaries; longest prefix has priority.
3. Each selected upstream increments `active` once and is released exactly once.
4. A failed upstream circuit does not recover until its cooldown expires, or an active health probe succeeds.
5. Only GET/HEAD requests without a body can be retried, only before response headers, and only within the rolling retry budget.
6. Headers listed by `Connection` plus hop-by-hop headers never traverse the proxy.
7. An upstream succeeds once its response stream finishes, not merely when headers arrive.
8. Client cancellation aborts the outbound request.
9. Sticky cookies are opaque HMAC tokens; an invalid, expired or tampered token falls back to normal selection.
10. Connect/headers/request/idle timers are independent; `0` disables a timer and idle inactivity is reset by upstream bytes.
11. Request plugins are DI-injected per module instance, sequential, capped at 32 and bounded by a shared timeout.
12. Plugins never receive the body, upstream registry, raw request/response or writable response objects; visible headers default to none.
13. Plugins cannot change the HTTP method or upstream; rewrites must stay within the initially matched route and preserve the original query.
14. Plugin header edits require an explicit allowlist and reject hop-by-hop, framing, Host, forwarded and request-id headers.
15. Plugin rejection, invalid output, exceptions, timeout and cancellation all fail closed before acquiring an upstream.
16. Adaptive strategies (`peak-ewma`, `p2c`) score `decayedEwma × (1 + active) ÷ weight`, decay latency over a 10-second window from `ewmaObservedAt`, and treat upstreams without samples as neutral candidates.
17. Forwarding metadata follows one shared rule (HTTP/1 and WebSocket): dropped unless `trustProxy` is enabled, never emitted empty, and the peer address is appended to a non-empty `X-Forwarded-For` chain. Per-attempt latency, not total request time, feeds adaptive selection.
18. Synthetic gateway responses set `Content-Length`, `Cache-Control: no-store`, and `Connection: close` while shutting down; client request ids are accepted only as 1–128 visible ASCII characters.
19. Runtime route reload validates the complete replacement before swapping, rejects bootstrap-only options, and carries counters, EWMA latency, circuit state and drain flags for unchanged route path + origin pairs. In-flight requests finish on the previous snapshot, whose per-node state is no longer reported.
20. Drained upstreams are excluded from selection without cancelling in-flight work; weights are mutable integers in `1..1000` and the configured value wins on reload.
21. Local rate limiting runs after route/Host validation and before plugins: buckets are method-independent, bounded by `maxKeys` with LRU eviction, cleared on reload, and a rejection never acquires an upstream or enters retry.
22. Cache hits are served only after rate limiting and plugins, for the exact route/method/URL/`accept-encoding`/configured-`vary` key. Authenticated, cookie-bearing, ranged, `no-store`/`private`, `Set-Cookie`, non-listed-status and oversized responses are never stored; bodies are buffered only up to `maxEntryBytes` while streaming.

## Scope

This release provides **HTTP/1.1 reverse proxying using NestJS Express middleware** plus opt-in WebSocket upgrade tunneling and an h2c transport. Suitable workloads include REST, JSON, GraphQL queries/mutations transmitted over HTTP, SSE, file uploads, sticky sessions, and standard HTTP streaming, subject to the documented timeouts and cancellation behavior. Fastify requires the manual hook export. There is no automatic Nest adapter for WebSocket/HTTP2, no TLS termination for h2c, no dynamic service discovery, no distributed metrics, and no generic TCP balancing. Do not route such protocols without dedicated integration tests.

## Extension contracts

Custom strategies implement `BalancerStrategy` and are registered with `registerStrategy`. A strategy receives the route and a list of currently eligible upstreams and **must return one from that exact list**. Registry registration currently has process-global semantics: avoid name collisions in multi-tenant applications.

Request plugins implement `RouteBalancerPlugin` and are provided through Nest tokens in `forRoot(options, plugins)` or `forRootAsync({ plugins, ... })`. The ordered chain runs once after route/host validation and before upstream selection. Configure `requestInterception.exposedHeaders` and `allowedHeaders` explicitly; both default to empty and protected transport/identity headers are forbidden in both lists. Decisions may rewrite only the pathname within the originally matched route, edit allowlisted headers, or reject with a 4xx/5xx status. Query strings remain unchanged. Method, body and upstream are immutable. The context is a frozen snapshot with an abort signal; asynchronous plugins must honor cancellation. Runtime output is validated, plugin errors are sanitized, and request work fails closed before upstream acquire. Plugins are trusted application code and must not block the event loop.

Future protocol adapters should not reuse HTTP/1 streaming logic for WebSocket/gRPC. They should implement a transport interface with explicit upgrade, cancellation, framing, TLS and backpressure contracts.

## Known limitations

- Per-process metrics, health checks, rate-limit buckets, response cache and sticky secret. Multi-replica deployments should set an explicit sticky secret, aggregate metrics externally and use a shared limiter when a global quota is required.
- Outlier ejection is process-local and based on consecutive 5xx responses; it does not replace distributed health checking.
- Circuit breaker and outlier windows are bounded but remain in-memory; restart clears state.
- Only the route table can change at runtime; `trustProxy`, transport/agent settings, SSRF policy and request interception are bootstrap-only. Runtime weights and drain flags are process-local and reset to configuration on restart.
- Plugins are trusted in-process code, not a sandbox. They must be non-blocking, honor the abort signal, and treat their configured header exposure as sensitive data.
- `trustProxy: true` assumes the ingress path is trusted; only enable behind a controlled reverse proxy.
- HTTP/2 is h2c only with one pooled session per origin; TLS/ALPN, graceful GOAWAY rotation and full gRPC semantics are not implemented.
