---
name: architecture
description: Guidance for changes to the NestJS route balancer lifecycle, state and proxy architecture.
---
# Architecture

- `balancer.module.ts`: dynamic module, dependency injection and Express middleware registration.
- `options.ts`: validates static upstream origins, path prefixes, health-check timings.
- `balancer.service.ts`: maintains mutable in-process health, counters and active requests.
- `strategies/select.ts`: pure target selection based on service state.
- `proxy/middleware.ts`: streams inbound HTTP requests to upstream and responses back to clients.
- `proxy/headers.ts`: strips hop-by-hop headers.

## Invariants

- Increment `active` exactly once on acquire, decrement at most once on completion.
- Fail closed with 503 when no healthy upstream is available.
- No automatic retry for non-idempotent requests.
- Never read request body before forwarding streams.
- Route prefix matching must respect segment boundaries (`/api` must not match `/apix`).
- Health checks must not block indefinitely and must clean up on module shutdown.
- Host header may be rewritten, but never forward untrusted hop-by-hop headers.

## Validation

Run `npm run check` and test the live gateway example on HTTP GET and POST.
