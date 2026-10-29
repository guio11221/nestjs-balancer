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
- `ROUTE_BALANCER_PLUGINS`: ordered plugin instances scoped to one DynamicModule instance.
- `RouteBalancerService.interceptRequest`: validates the plugin chain's immutable context and runtime decisions under a deadline.

## Invariants

- Increment `active` exactly once on acquire, decrement at most once on completion.
- Fail closed with 503 when no healthy upstream is available.
- No automatic retry for non-idempotent requests.
- Never read request body before forwarding streams.
- Route prefix matching must respect segment boundaries (`/api` must not match `/apix`).
- Health checks must not block indefinitely and must clean up on module shutdown.
- Host header may be rewritten, but never forward untrusted hop-by-hop headers.
- Plugins are resolved via Nest DI per module instance, never via a global registry.
- Interception runs once before acquire/body piping; never buffer or consume the request body.
- Plugins get a frozen, redacted context, never raw request/response, body, upstream or mutable route state.
- Rewrites preserve query and cannot escape the initially matched route; method and upstream are immutable.
- Plugin header writes require an explicit allowlist and cannot modify Host, framing, hop-by-hop, forwarded identity or request-id.
- Plugin chain has a shared bounded timeout, observes cancellation and fails closed before upstream acquisition.

## Validation

Run `npm run check`; add real Nest HTTP integration cases for plugin DI, order, redaction, allowlists, route-boundary rejection, timeout, cancellation and no upstream contact on failures. See `skills/plugins/SKILL.md`.
