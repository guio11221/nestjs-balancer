# Changelog

## 0.2.0

- Smooth Weighted Round Robin and weighted Least Connections tie handling.
- Extensible custom strategy registry.
- HTTP and HTTPS keep-alive agents with max sockets configuration.
- Passive circuit-breaker recovery/cooldown and success/failure accounting.
- Optional bounded retries for bodyless GET/HEAD requests only.
- Real HTTP integration tests, fixed CI structure, expanded documentation and development skills.

## 0.1.0

- Initial Express HTTP reverse proxy, route balancing and health checks.

## 0.3.0 (development preview)

- Hardened HTTP response-stream lifecycle, delayed success recording to response completion.
- Safer forwarding-header handling; removed untrusted RFC 7239 `Forwarded` values.
- Prevented overlapping active health probes for the same route and upstream.
- Reject configuration that requests unsafe/malformed retry methods.
- Added failure, transport cancellation, circuit recovery and header security integration tests.
- Added architecture, security, test documentation and dedicated proxy/test agent skills.

## 0.4.0 (experimental)

- Added opt-in HTTP/1.1 WebSocket Upgrade socket tunneling.
- Added Fastify raw-request hook integration helper.
- Added isolated experimental h2c-to-h2c transport.
- Added Prometheus exposition formatter.
- Added protocol regression tests, security/compatibility documentation, and a transport development skill.
- Still requires full typecheck and real NestJS/Fastify integration with installed npm dependencies.
