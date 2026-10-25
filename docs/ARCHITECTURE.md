# Architecture

## Request path

```text
Nest HTTP/1 Express request
  -> RouteBalancerMiddleware (match longest configured prefix)
  -> RouteBalancerService.acquire (filter unhealthy/open-circuit/attempted nodes)
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
5. Only GET/HEAD requests without a body can be retried, and only before response headers.
6. Headers listed by `Connection` plus hop-by-hop headers never traverse the proxy.
7. An upstream succeeds once its response stream finishes, not merely when headers arrive.
8. Client cancellation aborts the outbound request.

## Scope

This release provides **HTTP/1.1 reverse proxying using NestJS Express middleware**. Suitable workloads include REST, JSON, GraphQL queries/mutations transmitted over HTTP, SSE, file uploads, and standard HTTP streaming, subject to the documented timeouts and cancellation behavior. It does not support WebSocket upgrades, gRPC, HTTP/2 upstream multiplexing, Fastify adapters, dynamic service discovery, distributed metrics, or generic TCP balancing. Do not route such protocols until dedicated adapters and test suites exist.

## Extension contracts

Custom strategies implement `BalancerStrategy` and are registered with `registerStrategy`. A strategy receives the route and a list of currently eligible upstreams and **must return one from that exact list**. Registry registration currently has process-global semantics: avoid name collisions in multi-tenant applications.

Future protocol adapters should not reuse HTTP/1 streaming logic for WebSocket/gRPC. They should implement a transport interface with explicit upgrade, cancellation, framing, TLS and backpressure contracts.

## Known limitations

- Per-process metrics and health checks. Multi-replica synchronization needs an optional external store.
- Single general upstream timeout (not separate connect/first-byte/idle policies).
- No automatic response-based 5xx circuit-tripping; only network/transport failures and health probes affect passive circuit state.
- Configuration is static after module initialization.
- `trustProxy: true` assumes the ingress path is trusted; only enable behind a controlled reverse proxy.
