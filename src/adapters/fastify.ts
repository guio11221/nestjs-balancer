import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteBalancerMiddleware } from '../proxy/middleware';

export interface FastifyLike {
  addHook(name: 'onRequest', callback: (request: { raw: IncomingMessage }, reply: { raw: ServerResponse; hijack(): void }, done: (error?: Error) => void) => void): void;
}

/** Preferred adapter: only hijacks requests that match a configured balancer route. */
export function attachFastifyBalancer(
  fastify: FastifyLike,
  balancer: { findRoute(path: string): unknown },
  middleware: RouteBalancerMiddleware,
): void {
  fastify.addHook('onRequest', (request, reply, done) => {
    let pathname: string;
    try { pathname = new URL(request.raw.url ?? '/', 'http://gateway.invalid').pathname; }
    catch { done(); return; }
    if (!balancer.findRoute(pathname)) { done(); return; }
    reply.hijack();
    const handled = middleware.use(request.raw, reply.raw, (error?: unknown) => {
      if (error === undefined || error === null) done();
      else done(error instanceof Error ? error : new Error(String(error)));
    });
    // The middleware owns the response after hijack; unexpected rejections must
    // still terminate it instead of surfacing as an unhandled promise rejection.
    if (handled && typeof handled.catch === 'function') {
      void handled.catch(() => {
        if (reply.raw.destroyed) return;
        if (reply.raw.headersSent) {
          reply.raw.destroy();
          return;
        }
        const body = JSON.stringify({ statusCode: 500, message: 'Internal balancer error' });
        reply.raw.writeHead(500, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
          connection: 'close',
        });
        reply.raw.end(body);
      });
    }
  });
}
