import { connect, createServer, type ClientHttp2Session, type ClientHttp2Stream, type Http2Server, type ServerHttp2Stream, type IncomingHttpHeaders } from 'node:http2';
import type { RouteBalancerService } from '../balancer.service';

const HOP_HEADERS = new Set(['connection', 'upgrade', 'keep-alive', 'transfer-encoding', 'proxy-connection', 'host', 'http2-settings']);
function allowed(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith(':') || HOP_HEADERS.has(key) || value === undefined) continue;
    out[key] = value as string | string[];
  }
  return out;
}

/** h2c-to-h2c transport. Intended for internal gRPC and HTTP/2 services. */
export function createHttp2Balancer(balancer: RouteBalancerService): Http2Server {
  const server = createServer();
  const sessions = new Set<ClientHttp2Session>();
  server.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(String(headers[':path'] ?? '/'), 'http://gateway.invalid');
    } catch {
      stream.respond({ ':status': 400 });
      stream.end();
      return;
    }
    const route = balancer.findRoute(requestUrl.pathname);
    if (!route) {
      stream.respond({ ':status': 404 });
      stream.end();
      return;
    }
    const node = balancer.acquire(route);
    if (!node) {
      stream.respond({ ':status': 503 });
      stream.end();
      return;
    }
    const target = new URL(node.url);
    if (target.protocol !== 'http:') {
      balancer.release(node);
      stream.respond({ ':status': 502 });
      stream.end();
      return;
    }
    let session: ClientHttp2Session;
    try {
      session = connect(target.origin);
    } catch {
      balancer.failure(route, node);
      balancer.release(node);
      stream.respond({ ':status': 502 });
      stream.end();
      return;
    }
    sessions.add(session);
    let proxyStream: ClientHttp2Stream | undefined;
    let upstreamTrailers: Record<string, string | string[]> | undefined;
    let finished = false;
    const cleanup = (): void => {
      if (finished) return;
      finished = true;
      balancer.release(node);
      sessions.delete(session);
      session.close();
    };
    const fail = (): void => {
      if (finished) return;
      balancer.failure(route, node);
      if (!stream.destroyed) {
        if (!stream.headersSent) {
          try { stream.respond({ ':status': 502 }); } catch { stream.destroy(); }
        }
        try { stream.close(); } catch { stream.destroy(); }
      }
      if (proxyStream && !proxyStream.destroyed) proxyStream.close();
      cleanup();
    };
    session.once('error', fail);
    session.once('close', () => sessions.delete(session));
    const rewritten = route.config.stripPrefix ? (requestUrl.pathname.slice(route.path === '/' ? 0 : route.path.length) || '/') : requestUrl.pathname;
    try {
      proxyStream = session.request({
        ...allowed(headers),
        ':method': headers[':method'] ?? 'GET',
        ':path': rewritten + requestUrl.search,
        ':scheme': 'http',
        ':authority': target.host,
      });
    } catch {
      fail();
      return;
    }
    proxyStream.on('response', responseHeaders => {
      if (stream.destroyed) return;
      stream.respond({ ...allowed(responseHeaders), ':status': responseHeaders[':status'] ?? 502 }, { waitForTrailers: true });
    });
    proxyStream.on('trailers', trailers => {
      upstreamTrailers = allowed(trailers);
    });
    stream.on('wantTrailers', () => {
      try { stream.sendTrailers(upstreamTrailers ?? {}); } catch { stream.close(); }
    });
    proxyStream.once('end', () => {
      if (finished) return;
      balancer.success(node);
      cleanup();
    });
    proxyStream.once('error', fail);
    stream.once('error', fail);
    stream.once('close', () => {
      if (!finished && proxyStream && !proxyStream.destroyed) proxyStream.close();
      cleanup();
    });
    stream.pipe(proxyStream);
    proxyStream.pipe(stream);
  });
  server.once('close', () => { for (const session of sessions) session.destroy(); });
  return server;
}
