# Security checklist

**Threat model:** The balancer forwards requests to server-side origins. Its configuration is privileged; never accept route or upstream URLs from untrusted request input.

- Set upstream URLs only from operator-controlled configuration. Avoid resolving private, link-local or metadata endpoints on behalf of tenants (SSRF). The built-in guard rejects malformed/credentialed origins, private ranges, loopback, link-local, IPv6 literals and IPv4-mapped IPv6 when enabled, but it is not a complete DNS-rebinding boundary. For compatibility, `ssrf.allowPrivate` and `ssrf.allowLocalhost` default to `true`; set them to `false` in deployments that never target private infrastructure. Link-local and metadata targets remain blocked unless `ssrf.allowLinkLocal` is explicitly enabled.
- Use TLS upstream URLs for untrusted networks and manage certificate verification/rotation at the platform level.
- Keep `trustProxy: false` unless the gateway accepts traffic only through a trusted ingress which strips client-supplied forwarding headers. Configure ingress network ACLs separately. When enabled, `X-Forwarded-For` is appended with the peer address and empty entries are discarded; `X-Forwarded-Host` is taken from the existing header or the client `Host` and never emitted empty.
- Client `x-request-id` values are accepted only as 1–128 visible ASCII characters and are otherwise replaced. Do not rely on this header for authorization or audit identity; correlate with your own authenticated request context.
- Use `allowedHosts` (exact or `*.suffix`) when the gateway must reject unexpected Host headers; it returns `421` for malformed/mismatched hosts on HTTP/1.
- Set an explicit high-entropy `sticky.secret` for multi-replica deployments. Without it, sticky tokens are tied to one process and invalid after restart.
- Add authentication/authorization, request size limits, rate limits, and audit logging at the edge or Nest host; this module is **not** an API security gateway.
- Runtime controls (`drainUpstream`, `resumeUpstream`, `setUpstreamWeight`, `reloadRoutes`) are privileged operations. Never expose them without authentication/authorization, and never accept route tables or upstream URLs from untrusted request input. `reloadRoutes` validates structure but still treats upstream URLs as trusted configuration (SSRF and traffic-redirection risk). Prefer loading routes from signed, reviewed configuration and audit every runtime change.
- Request plugins are trusted code running in-process, not a security sandbox. Register only reviewed providers, keep the chain small, avoid blocking CPU work, and honor the provided abort signal.
- Plugin context redacts all headers by default. Expose only the exact names needed using `requestInterception.exposedHeaders`; sensitive headers should normally remain hidden. The proxy identity and protected transport headers are rejected in exposure lists as well as mutation lists.
- Plugin header mutations require a separate explicit `allowedHeaders` list. The module blocks Host, request framing, hop-by-hop, forwarded identity and request-id headers even if a caller attempts to allow them.
- A plugin may rewrite only the pathname within the originally matched route. It cannot alter method, query string, body, or upstream; encoded path separators/dot segments, other percent-encoded octets, malformed encodings and control characters are rejected.
- Plugin chains execute sequentially under one timeout (default 1000 ms, max 30000 ms). Timeout, malformed plugin decisions and exceptions fail closed before upstream acquisition; do not configure a fail-open path for authorization plugins.
- Plugin rejection messages are capped and returned as JSON; plugin exceptions are replaced with a generic error response. Avoid embedding credentials, tokens or internal policy details in deliberate rejection messages.
- Response caching is opt-in and skips requests with `Authorization`, `Cookie` or `Range`, responses with `Set-Cookie`, and anything marked `no-store`/`private`/`no-cache`. Never relax those rules with a custom proxy layer: a shared cache must not replay identity-bound responses. Cache keys include `accept-encoding` and every configured `Vary` header; list a header in `cache.vary` before an upstream varies on it, otherwise those responses are simply not cached.
- Cache entries are process-local and invalidated only on the replica that handled a write. Keep TTLs short for mutable resources and purge at the CDN/edge when several replicas must agree.
- Local rate limiting is a volume control, not authentication. The `key: 'header'` identity is client-controlled unless a trusted ingress validates it; prefer signed API keys at the edge. With `trustProxy: false` the bucket keys on the TCP peer and ignores spoofed `X-Forwarded-For`; with `trustProxy: true` only the first hop is used. Bound memory with `maxKeys` and remember each replica enforces its own bucket.
- Restrict the maximum request duration/size at ingress and configure connect/headers/request/idle timeouts for SSE and uploads. `0` disables a timer and should be used deliberately.
- Do not allow arbitrary POST/PUT/PATCH retries. This project enforces GET/HEAD without bodies for replay and a rolling retry budget.
- Prefer readonly routes and separate trusted credentials per upstream.
- Protect application secrets, disable verbose headers, and audit CORS policy at the application level.
- Test header smuggling protections and upstream behavior with your actual ingress load balancer before internet-facing deployment.
- Allow `shutdownTimeoutMs` for graceful draining and ensure the process exits only after active requests are aborted or completed. Plugin work shares the request lifecycle and receives cancellation during client disconnect and shutdown.

## Reporting

Follow `SECURITY.md` for private vulnerability disclosures; avoid publishing working exploit details in public issues.
