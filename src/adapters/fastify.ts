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
    middleware.use(request.raw, reply.raw, (error?: unknown) => {
      if (error === undefined || error === null) done();
      else done(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
