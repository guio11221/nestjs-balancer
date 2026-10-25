# Proxy Review Skill

Use when changing `src/proxy` or HTTP forwarding behavior.

1. Read `docs/ARCHITECTURE.md` and `docs/SECURITY-HARDENING.md`.
2. Verify body backpressure, cancellation, stream completion, and one-time release on every branch.
3. Strip static hop-by-hop headers and dynamic `Connection` tokens, for both request and response.
4. Never replay non-idempotent methods. Restrict retries to bodyless GET/HEAD before response headers.
5. Keep transport errors separate from successful HTTP responses with 4xx/5xx status.
6. Add a failing integration test with real loopback servers for every bug fixed.
7. Run `npm run check` and record commands and results in PR.
