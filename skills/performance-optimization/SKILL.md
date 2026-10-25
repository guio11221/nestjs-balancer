---
name: performance-optimization
summary: Optimize load balancer throughput without compromising correctness.
---
# Performance optimization

1. Establish a baseline with 1, 10, 100 concurrent clients against a real upstream.
2. Benchmark gateway and direct-to-upstream latency separately; record p50/p95/p99, RSS, errors, throughput.
3. Profile `http.Agent`/`https.Agent` socket use and TLS handshakes before tuning `maxSockets`.
4. Review algorithmic complexity; do not add blocking synchronous work to the request path.
5. Validate forwarding correctness for query/body/headers after optimization.
6. Run `npm run check` and repeat benchmarks. Report numbers with machine, version and command.

Do not assert benchmark improvements without recorded measurements.
