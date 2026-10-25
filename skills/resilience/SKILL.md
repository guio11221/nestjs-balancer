---
name: resilience
summary: Extend retries, circuit breakers, and health checks safely.
---
# Resilience

- Maintain per-upstream closed/open/half-open transitions. Never allow stampedes of half-open probes.
- Active health checks and passive transport error reports must have well-defined interaction.
- Retry only when replay of the request is provably safe and the response has not started.
- Never infer that all POST endpoints are idempotent. Honor explicit idempotency policies only after adding replay support and tests.
- Use bounded timeouts, retry counts, and backoff; avoid amplifying incidents.
- Expose metrics for transitions, failures and retry counts; instrument tests using a simulated clock when possible.
