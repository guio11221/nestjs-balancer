# Integration Test Skill

Use before approving changes to public API, resilience, routing, or transport.

1. Build the source before integration tests (`npm run build`).
2. Prefer `node:test` and native `node:http`, using port 0 and `127.0.0.1` to avoid collisions.
3. Register `t.after` cleanup for every server and service.
4. Cover success, failure, cancellation, timeouts, malformed headers, and concurrency as applicable.
5. Avoid fixed sleeps except bounded cooldown/timeout tests; keep tests deterministic.
6. Assert counters and status codes, not only response payloads.
7. Run Node 20 and 22 in CI; do not claim tests passed without execution.
