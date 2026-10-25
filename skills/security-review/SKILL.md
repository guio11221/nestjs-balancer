---
name: security-review
description: Audit proxy, routing, forwarded headers and upstream config changes for security risks.
---
# Security review

- [ ] Untrusted client input cannot set upstream origins (SSRF).
- [ ] HTTP(S) protocol is enforced for configured upstreams.
- [ ] Connection and all dynamically named hop-by-hop headers are stripped.
- [ ] Authentication/authorization and rate limits stay in front of the proxy.
- [ ] `X-Forwarded-*` semantics do not trust an untrusted peer.
- [ ] Request body remains streamed, not buffered or reserialized.
- [ ] Errors after headers are sent terminate the stream, never send a second response.
- [ ] Timeouts, aborts, health checks and socket cleanup are covered.
- [ ] TLS certificate verification is never disabled.
- [ ] No retries of unsafe methods without explicit idempotency guarantees.
- [ ] Update `SECURITY.md` with residual risks.
