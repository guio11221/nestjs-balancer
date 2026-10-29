# Documentation

This directory is organized by intent: **guides** teach a task, **reference** describes contracts, and **operations** covers running, securing and testing a deployment.

## Start here

| If you want to… | Read |
| --- | --- |
| Install and proxy your first route | [README](../README.md) |
| Solve a concrete task (retries, sticky sessions, plugins, metrics) | [guides/examples.md](guides/examples.md) |
| Look up every option, default and validation rule | [reference/configuration.md](reference/configuration.md) |
| Limit traffic per client | [guides/rate-limiting.md](guides/rate-limiting.md) |
| Cache GET/HEAD responses | [guides/caching.md](guides/caching.md) |
| Understand selection, health and transport design | [reference/architecture.md](reference/architecture.md) |
| Enable WebSocket, Fastify or h2c | [guides/transports.md](guides/transports.md) |
| Expose metrics | [guides/metrics.md](guides/metrics.md) |
| Harden a deployment | [operations/security-hardening.md](operations/security-hardening.md) |
| Run or write tests | [operations/testing.md](operations/testing.md) |
| Benchmark locally | [operations/benchmarks.md](operations/benchmarks.md) |

## Guides

- [Examples and recipes](guides/examples.md) — minimal gateway, async configuration, resilience tuning, plugins, custom strategies, runtime control, troubleshooting.
- [Rate limiting](guides/rate-limiting.md) — local token buckets per route/client, headers, `429`, memory bounds and limitations.
- [Response caching](guides/caching.md) — opt-in `GET`/`HEAD` caching, TTL/Vary, invalidation, coalescing and memory budgets.
- [Metrics](guides/metrics.md) — Prometheus exposition, protected endpoint and available series.
- [Transports](guides/transports.md) — opt-in WebSocket, Fastify and h2c adapters and their limitations.

## Reference

- [Configuration](reference/configuration.md) — `RouteBalancerOptions`, `RouteOptions`, defaults, validation and runtime controls.
- [Architecture](reference/architecture.md) — request path, invariants, extension contracts and known limitations.

## Operations

- [Security hardening](operations/security-hardening.md) — threat model and deployment checklist.
- [Testing](operations/testing.md) — commands, coverage matrix and preproduction tests.
- [Benchmarks](operations/benchmarks.md) — reproducible performance measurement.

## Conventions

- Documentation is English-only, like the source and public API.
- Every default and validation rule lives in [reference/configuration.md](reference/configuration.md); guides link there instead of duplicating tables.
- Examples assume the Express adapter with `bodyParser: false`, because the proxy streams the original request.
- Experimental capabilities are labeled as such; do not treat them as production contracts.

## Related files outside `docs/`

- [README](../README.md) — install, quick start and supported/unsupported matrix.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — contributor workflow.
- [SECURITY.md](../SECURITY.md) — private vulnerability reporting.
- [AGENTS.md](../AGENTS.md) and [skills/](../skills/README.md) — AI agent instructions and playbooks.
