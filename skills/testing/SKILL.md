---
name: testing
summary: Add reliable unit, integration, and failure tests for HTTP balancing.
---
# Testing

- Unit test selection sequence, weighted proportions, least-connections ties, unavailable targets, and validation.
- Integration tests must open ephemeral listening ports, use actual HTTP clients, and close all servers in `t.after`.
- Failure matrix: ECONNREFUSED, health failure, timeout, client abort, upstream abort after headers, zero healthy targets, recovery after cooldown.
- Security tests: untrusted forwarded headers, Connection token stripping, invalid target URLs and target egress boundaries.
- Verify GET retry to a distinct target, **never** automatic POST/PUT/PATCH replay.
- Run `npm run check`; do not claim tests ran if dependencies cannot be installed.
