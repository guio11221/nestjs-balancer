import { request as httpRequest, type IncomingMessage, type Server, type ClientRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import type { RouteBalancerService } from '../balancer.service';
import { applyForwardedHeaders, sanitizeHeaders } from '../proxy/headers';

/** HTTP/1.1 WebSocket upgrade tunneling. Does not parse WebSocket frames. */
export function attachWebSocketBalancer(server: Server, balancer: RouteBalancerService): () => void {
  const sockets = new Set<Socket>();
  const onUpgrade = (request: IncomingMessage, client: Socket, head: Buffer): void => {
    let requested: URL;
    try {
      requested = new URL(request.url ?? '/', 'http://gateway.invalid');
    } catch {
      client.destroy();
      return;
    }
    const route = balancer.findRoute(requested.pathname);
    if (!route) {
      client.destroy();
      return;
    }
    const upstream = balancer.acquire(route);
    if (!upstream) {
      client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.add(client);
    let released = false;
    let clientClosed = false;
    let settled = false;
    let outgoing: ClientRequest | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    const idleTimeoutMs = route.config.timeouts?.idleTimeoutMs ?? route.config.timeoutMs ?? 30000;
    const release = (): void => {
      if (released) return;
      released = true;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = undefined;
      sockets.delete(client);
      balancer.release(upstream);
    };
    client.once('close', () => {
      clientClosed = true;
      sockets.delete(client);
      if (!settled) outgoing?.destroy();
      release();
    });

    const destination = new URL(upstream.url);
    destination.pathname = route.config.stripPrefix ? (requested.pathname.slice(route.path === '/' ? 0 : route.path.length) || '/') : requested.pathname;
    destination.search = requested.search;
    const headers = sanitizeHeaders(request.headers);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    if (route.config.changeOrigin ?? true) headers.host = destination.host;
    applyForwardedHeaders(headers, {
      trustProxy: balancer.options.trustProxy ?? false,
      remoteAddress: request.socket.remoteAddress,
      protocol: request.socket instanceof TLSSocket && request.socket.encrypted ? 'https' : 'http',
      host: request.headers.host,
    });

    const makeRequest = destination.protocol === 'https:' ? httpsRequest : httpRequest;
    try {
      outgoing = makeRequest(destination, { method: 'GET', headers, agent: false }, response => {
        settled = true;
        if (timeout) clearTimeout(timeout);
        response.resume();
        client.end(`HTTP/1.1 ${response.statusCode ?? 502} Upgrade Rejected\r\nConnection: close\r\n\r\n`);
        release();
      });
    } catch {
      balancer.failure(route, upstream);
      client.destroy();
      release();
      return;
    }
    timeout = setTimeout(() => outgoing?.destroy(new Error('WebSocket handshake timeout')), route.config.timeoutMs ?? 30000);
    outgoing.once('upgrade', (response, backend, backendHead) => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      balancer.success(upstream, route);
      sockets.add(backend);
      let backendClosed = false;
      const closeBackend = (): void => {
        if (backendClosed) return;
        backendClosed = true;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = undefined;
        sockets.delete(backend);
        if (!client.destroyed) client.destroy();
        release();
      };
      const armIdle = (): void => {
        if (idleTimeoutMs <= 0 || backendClosed) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (!client.destroyed) client.destroy();
          if (!backend.destroyed) backend.destroy();
        }, idleTimeoutMs);
        idleTimer.unref?.();
      };
      armIdle();
      client.on('data', armIdle);
      backend.on('data', armIdle);
      backend.once('close', closeBackend);
      backend.once('error', closeBackend);
      client.once('close', () => {
        if (!backend.destroyed) backend.destroy();
        closeBackend();
      });
      const status = response.statusCode ?? 101;
      const lines = [`HTTP/1.1 ${status} ${response.statusMessage ?? 'Switching Protocols'}`];
      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      client.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (backendHead.length) client.write(backendHead);
      if (head.length) backend.write(head);
      client.pipe(backend).pipe(client);
      backend.once('error', () => client.destroy());
      client.once('error', () => backend.destroy());
    });
    outgoing.once('error', () => {
      if (timeout) clearTimeout(timeout);
      if (!settled && !clientClosed) balancer.failure(route, upstream);
      client.destroy();
      release();
    });
    outgoing.end();
  };
  server.on('upgrade', onUpgrade);
  return () => {
    server.off('upgrade', onUpgrade);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
}
