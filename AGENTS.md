# Agent instructions

This is a TypeScript NestJS HTTP/1.x Express reverse proxy package, not a universal protocol gateway.

1. Preserve the public exports in `src/index.ts` unless a documented major version requires a breaking change.
2. Add a regression test for each bug fix. Run `npm run check` where dependencies are available.
3. Avoid replaying streaming request bodies and non-idempotent requests. Keep attempts bounded.
4. Treat upstream URLs as trusted configuration; do not accept arbitrary client-controlled proxy targets.
5. Keep body-parser disabled in gateway examples; verify `req.pipe()` streaming behavior.
6. Maintain cleanup for timers, sockets, active counts and agents.
7. Do not claim WebSocket, Fastify, HTTP/2 or gRPC support unless an adapter with integration tests exists.
8. Follow relevant playbooks in `skills/` for major modifications.

## Mandatory engineering rules

- Keep code formatted consistently with two-space indentation and full TypeScript types.
- Preserve public exports and semver compatibility; changing option names requires a migration guide.
- Never report test success unless the command executed successfully.
- Read `docs/reference/architecture.md` before modifying transport or selection logic.
- Read `docs/reference/configuration.md` before adding options, and document defaults and validation there.
- Read `skills/proxy-review/SKILL.md` for HTTP proxy changes and `skills/integration-tests/SKILL.md` before changing tests.
