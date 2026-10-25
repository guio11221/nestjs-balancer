---
name: add-adapter
summary: Add transport adapters without coupling selection to HTTP framework internals.
---
# Adding a transport adapter

1. Define adapter interface for request metadata, streaming request/response, abort propagation, and lifecycle.
2. Preserve route and upstream selection API; adapter must not implement its own balancing algorithm.
3. Implement protocol-specific behaviors explicitly: WebSocket uses Upgrade and bidirectional sockets; gRPC needs HTTP/2 semantics.
4. Test disconnect propagation, backpressure, header propagation, deadlines and graceful shutdown.
5. Separate Express and Fastify registrations; never call an Express middleware a Fastify-compatible adapter.
6. Document capability matrix and all unimplemented behavior.
