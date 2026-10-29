# Skill: Add or evolve a transport

1. Preserve HTTP/1.1 public API semantics and route-prefix selection.
2. Model protocol-specific lifetime separately: request, response, upgrade socket, HTTP/2 stream and session are not interchangeable.
3. Normalize forwarded headers at trust boundaries; strip hop-by-hop headers and prevent client-origin spoofing.
4. Prohibit unsafe retries after request body forwarding or response headers transmission.
5. Add tests for handshake, payload, client abort, upstream abort, target unavailable, resource cleanup and graceful shutdown.
6. For gRPC, test grpc-status/trailers, deadlines, TLS, cancellation and unary/client/server/bidirectional streaming before declaring support.
7. Provide standalone example and update docs/guides/transports.md for new adapters.
8. Require npm run check with installed dependencies; transpilation alone does not prove type safety.
