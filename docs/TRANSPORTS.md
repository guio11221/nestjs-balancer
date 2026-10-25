# Transports and compatibility

This package exposes a core HTTP/1.1 NestJS middleware and *separate opt-in transports*. Each transport must be tested independently. It is **not** a universal transparent L4 balancer.

| Protocol | Export | Current capability | Limitations |
| --- | --- | --- | --- |
| REST / JSON / GraphQL over HTTP/1.1 | `RouteBalancerModule` | Streaming HTTP(S) reverse proxy | GraphQL subscriptions over WebSocket require WebSocket attachment |
| WebSocket (`ws` / `wss` upstream) | `attachWebSocketBalancer(server, service)` | HTTP/1.1 Upgrade handshake and byte tunneling over HTTP(S) origins | No frame-level inspection; not RFC-compliance certified; caller owns HTTP server lifecycle |
| Fastify | `attachFastifyBalancer(instance, service, middleware)` | Root `onRequest` hook using raw Node streams | Explicit integration, not automatic Nest Fastify adapter; register before routes |
| HTTP/2 cleartext | `createHttp2Balancer(service)` | h2c-to-h2c streaming, HTTP/2 request/response headers | Experimental: one session per stream, no upstream TLS or trailers; NOT production gRPC-compatible |
| gRPC | HTTP/2 experimental path | Can carry simple framed request and response bodies | Trailers, grpc-status, TLS and cancellation propagation need dedicated integration tests |
| HTTP/2 TLS | none | Not implemented | Requires ALPN/TLS, certificate configuration and pooling |

## Fastify

```ts
import { RouteBalancerMiddleware, RouteBalancerService, attachFastifyBalancer } from 'nestjs-route-balancer-kit';

// Within application setup, with dependencies obtained from Nest's injector:
const service = app.get(RouteBalancerService);
const middleware = app.get(RouteBalancerMiddleware);
const adapter = app.getHttpAdapter();
attachFastifyBalancer(adapter.getInstance(), service, middleware);
```

When using this manual hook, do not simultaneously enable global Nest middleware to proxy the same routes; choose one integration point per HTTP server.

## WebSocket

```ts
const server = app.getHttpServer();
const disposeUpgrades = attachWebSocketBalancer(server, app.get(RouteBalancerService));
// Call disposeUpgrades() during application shutdown.
```

The WebSocket adapter handles matching requests only and closes unmatched upgrades. If your HTTP server also serves other WebSocket endpoints, integrate explicit upgrade routing instead of attaching competing listeners.

## HTTP/2 (experimental)

```ts
const gateway = createHttp2Balancer(app.get(RouteBalancerService));
gateway.listen(8443);
```

Use cleartext HTTP/2 only behind a trusted network boundary. This function does not terminate TLS and does not implement a complete gRPC proxy.
