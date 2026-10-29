---
name: plugins
description: Build and review per-module NestJS plugins and secure request interception for nestjs-balancer.
---
# Balancer plugins and request interception

Read `AGENTS.md`, `docs/reference/architecture.md`, `docs/operations/security-hardening.md`, `docs/operations/testing.md`, `skills/architecture/SKILL.md`, `skills/proxy-review/SKILL.md`, `skills/security-review/SKILL.md`, and `skills/integration-tests/SKILL.md` before changing this area.

## Current contract

- `RouteBalancerPlugin` implements `onRequest(context)` and returns void, a decision, or a promise of either.
- Plugins are trusted in-process Nest providers, not sandboxed user code.
- `RouteBalancerModule.forRoot(options, { imports?, providers?, inject? })` and `forRootAsync({ ..., plugins: { imports?, providers?, inject? } })` resolve ordered plugin instances in that DynamicModule's DI scope. Do not add a process-global registry.
- `ROUTE_BALANCER_PLUGINS` and `ROUTE_BALANCER_OPTIONS` are internal DI tokens, not public API.
- At most 32 plugins execute sequentially in registration order. All share one timeout (default 1000ms, configured 1..30000ms).
- Interception runs after route selection and Host allowlist checks, before any upstream acquire or request-body piping. It runs once, not once per retry.
- Context is a frozen snapshot: request id, matched route, method, pathname, original query, explicitly exposed headers, AbortSignal. No body, raw request/response, selected upstream, service or mutable route state.
- Header exposure and mutation both default to empty. Plugins may only mutate names in `requestInterception.allowedHeaders`.
- Reject hop-by-hop/framing headers, Host, forwarded identity headers, and request-id, regardless of configuration; protected names are disallowed in both exposure and mutation lists. Reject invalid token names, all C0/DEL control characters, non-string values and values over 8192 characters.
- Path changes are pathname-only; preserve the original query, and remain within the route prefix matched before plugins. Reject protocol-relative paths, control characters, backslashes, percent-encoded octets, encoded separators/dot-segments, malformed encodings and traversal across route boundaries.
- Method, body, Host policy decision, upstream set, and upstream selection policy cannot be modified. Rewrites do not rematch to a different route.
- Plugin rejection statuses must be 400..599; rejection objects accept only `statusCode` and `message`, with messages max 256 characters. Plugin exceptions are mapped to a generic 500 (never expose plugin error details); invalid output, timeout, or cancellation fails closed without acquiring an upstream.
- The request AbortSignal is triggered by deadline, client cancellation and shutdown. Plugins should honor it; timeout work is awaited only to the deadline and cannot be forcibly stopped if plugin code ignores cancellation.
- Plugin authors must avoid blocking the event loop and must not leak secrets through error text/logs.

## Change checklist

1. Keep the public exports semver-safe. Export only documented public plugin and options types from `src/index.ts`.
2. Preserve order and per-module DI isolation across `forRoot`, `forRootAsync`, repeated imports and multiple balancer modules in one Nest application.
3. Validate options before starting traffic. Never trust a plugin decision merely because its TypeScript type says it is valid; validate every runtime value and reject unknown keys.
4. Keep failure behavior fail-closed and before upstream acquisition. Never replay a request stream because an interception plugin failed.
5. Keep Host/SSRF checks ahead of plugins, do not expose raw request/response or body, and do not permit plugins to alter origins, methods or framing.
6. Track request lifecycle and listeners so disconnect/shutdown aborts, and ensure timer/listener cleanup occurs on success and every error branch.
7. Do not let plugins mutate later-plugin context: all plugins see the same immutable snapshot; only validated accumulated decisions affect final forwarding.
8. Add unit tests for configuration, path grammar, protected headers, rejected output and limits. Add real-loopback Nest integration tests for provider injection, ordering, isolation, rewrite/query preservation, zero upstream requests on rejection/error/timeout, cancellation and shutdown.
9. Use `t.after` for app/upstream cleanup. Use bounded never-settling plugin promises for deadline tests and check status, upstream counters and abort signal.
10. Run `npm run check`, then `npm run pack:check` when package exports/types or published files change. Verify emitted `.d.ts` contains the intended contract.
11. Update this skill, `skills/README.md`, architecture/security/testing docs and README whenever plugin behavior or invariants change. Keep all of them consistent with actual tests; never assert unverified compatibility or guarantees.
