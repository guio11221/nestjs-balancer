# Testing strategy

## Commands

```bash
npm install
npm run check
npm run pack:check
```

`npm run check` performs typechecking, compilation, unit tests and network integration tests using ephemeral `127.0.0.1` ports. There are no public endpoints, API keys or external dependencies for the integration tests beyond NestJS/TypeScript installation.

## Coverage matrix

| Layer | Expected invariants |
|---|---|
| Configuration | malformed routes, duplicates, unsupported URL schemes, invalid weights, retry limits |
| Strategy | cyclic, smooth weighted, least connections, custom strategy guard |
| Proxy | method, body, query string, streaming, hop-by-hop headers, forwarded headers |
| Resilience | connect failure, GET failover, no POST replay, open/half-open/recovered circuit |
| Lifecycle | release active counters, cleanup on abort, destroy agents and timers |

## Additional preproduction tests

Run application-level tests with actual NestJS controllers, test with NGINX/Envoy frontends, benchmark with `autocannon` or `wrk` against representative payloads and keep-alive profiles, run fault injection with slow/fragmented response streams, and perform protocol security reviews. The current suite is a regression baseline, not proof of production reliability.
