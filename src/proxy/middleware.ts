import { Injectable, type NestMiddleware } from '@nestjs/common';
import { type ClientRequest, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';
import type { NextFunction } from 'express';
import { RouteBalancerService } from '../balancer.service';
import type { ProxyRequest, ProxyResponse, RouteState, UpstreamState } from '../types';
import { sanitizeHeaders } from './headers';

function getRequestId(request: ProxyRequest): string {
  const existing = request.headers['x-request-id'];
  if (typeof existing === 'string' && existing.trim()) return existing.trim();
  if (Array.isArray(existing) && existing[0]?.trim()) return existing[0].trim();
  return randomBytes(16).toString('hex');
}

function resolveTimeouts(route: RouteState): { connect: number; headers: number; request: number; idle: number } {
  const t = route.config.timeouts || {};
  const fallback = route.config.timeoutMs ?? 30000;
  return {
    connect: t.connectTimeoutMs ?? Math.min(fallback, 5000),
    headers: t.headersTimeoutMs ?? fallback,
    request: t.requestTimeoutMs ?? fallback,
    idle: t.idleTimeoutMs ?? fallback,
  };
}

function computeBackoff(base: number, attempt: number, jitterMs = 0): number {
  const exp = base * Math.max(1, attempt);
  if (jitterMs <= 0) return exp;
  const jitter = Math.floor(Math.random() * (jitterMs * 2 + 1)) - jitterMs;
  return Math.max(0, exp + jitter);
}

/** HTTP/1.1 streaming transport. Upgrade (WebSocket) and HTTP/2 require separate adapters. */
@Injectable()
export class RouteBalancerMiddleware implements NestMiddleware {
  constructor(private readonly balancer: RouteBalancerService) {}

  use(request: ProxyRequest, response: ProxyResponse, next: NextFunction): void {
    let requested: URL;
    try {
      requested = new URL(request.originalUrl ?? request.url ?? '/', 'http://gateway.invalid');
    } catch {
      this.respond(response, 400, 'Malformed request URL');
      return;
    }

    const route = this.balancer.findRoute(requested.pathname);
    if (!route) {
      next();
      return;
    }

    const method = (request.method ?? 'GET').toUpperCase();
    const permitted = (route.config.retry?.methods ?? ['GET', 'HEAD']).map(value => value.toUpperCase());
    // Retries cannot replay request streams and must never duplicate arbitrary mutations.
    const replayable = (method === 'GET' || method === 'HEAD')
      && permitted.includes(method)
      && request.headers['content-length'] === undefined
      && request.headers['transfer-encoding'] === undefined;
    const maxAttempts = replayable ? 1 + (route.config.retry?.attempts ?? 0) : 1;
    const excluded = new Set<string>();
    let currentRequest: ClientRequest | undefined;
    let currentUpstream: UpstreamState | undefined;
    let activeTimer: NodeJS.Timeout | undefined;
    let backoffTimer: NodeJS.Timeout | undefined;
    let completed = false;
    let clientAborted = false;
    let attempts = 0;
    const requestId = getRequestId(request);
    const timeouts = resolveTimeouts(route);
    const startTime = Date.now();

    const clearAttempt = (): void => {
      if (activeTimer) clearTimeout(activeTimer);
      activeTimer = undefined;
      if (currentUpstream) this.balancer.release(currentUpstream);
      currentUpstream = undefined;
    };
    const finish = (): void => {
      if (completed) return;
      completed = true;
      if (backoffTimer) clearTimeout(backoffTimer);
      backoffTimer = undefined;
      clearAttempt();
    };
    const terminate = (status: number, message: string): void => {
      if (completed) return;
      if (response.headersSent) {
        finish();
        try { response.destroy(); } catch {}
        return;
      }
      finish();
      try { this.respond(response, status, message); } catch {}
    };

    const attempt = (): void => {
      if (completed || response.destroyed) return;
      // sticky session support
      let upstream: UpstreamState | undefined;
      let stickyUsed = false;
      const sticky = (route.config as any).sticky;
      if (sticky && sticky.cookie) {
        const cookies = (request.headers.cookie || '').split(';');
        for (let i = 0; i < cookies.length; i++) {
          const p = cookies[i].trim();
          if (p.startsWith(sticky.cookie + '=')) {
            const val = decodeURIComponent(p.substring(sticky.cookie.length + 1));
            const found = route.upstreams.find(u => u.url === val || u.url.includes(val));
            if (found) {
              const now = Date.now();
              if (found.healthy && !excluded.has(found.url) && !(found.ejectedUntil && found.ejectedUntil > now)) {
                upstream = found;
                found.active++;
                found.requests++;
                excluded.add(found.url);
                currentUpstream = upstream;
                stickyUsed = true;
              }
            }
            break;
          }
        }
      }
      if (!upstream) {
        upstream = (this.balancer as any).acquire(route, excluded);
      }
      if (!upstream) {
        terminate(attempts ? 502 : 503, attempts ? 'No remaining healthy upstream' : 'No healthy upstream available');
        return;
      }
      attempts++;
      excluded.add(upstream.url);
      currentUpstream = upstream;
      const sticky2 = (route.config as any).sticky;
      if (sticky2 && sticky2.cookie && !stickyUsed) {
        try {
          const maxAge = sticky2.ttlMs ? Math.floor(sticky2.ttlMs / 1000) : 3600;
          const parts = [`${sticky2.cookie}=${encodeURIComponent(upstream.url)}`, `Max-Age=${maxAge}`, 'Path=/'];
          if (sticky2.httpOnly !== false) parts.push('HttpOnly');
          if (sticky2.secure) parts.push('Secure');
          if (sticky2.sameSite) parts.push(`SameSite=${sticky2.sameSite}`);
          response.setHeader('Set-Cookie', parts.join('; '));
        } catch {}
      }
      const destination = this.destination(requested, route, upstream);
      const headers = sanitizeHeaders(request.headers);
      if (route.config.changeOrigin ?? true) headers.host = destination.host;
      // Untrusted client forwarded headers must not be forwarded or treated as authoritative.
      if (!this.balancer.options.trustProxy) {
        delete headers['forwarded'];
        delete headers['x-forwarded-for'];
        delete headers['x-forwarded-host'];
        delete headers['x-forwarded-proto'];
      }
      headers['x-request-id'] = requestId;
      response.setHeader('x-request-id', requestId);
      const remoteAddress = request.socket.remoteAddress;
      const existingFor = headers['x-forwarded-for'];
      if (remoteAddress) {
        headers['x-forwarded-for'] = typeof existingFor === 'string'
          ? `${existingFor}, ${remoteAddress}`
          : remoteAddress;
      }
      headers['x-forwarded-host'] = this.balancer.options.trustProxy
        ? (headers['x-forwarded-host'] ?? request.headers.host ?? '')
        : (request.headers.host ?? '');
      headers['x-forwarded-proto'] = this.balancer.options.trustProxy
        ? (headers['x-forwarded-proto'] ?? (request.socket instanceof TLSSocket && request.socket.encrypted ? 'https' : 'http'))
        : (request.socket instanceof TLSSocket && request.socket.encrypted ? 'https' : 'http');

      let headersReceived = false;
      let recordedFailure = false;
      const fail = (): void => {
        if (recordedFailure || completed || clientAborted) return;
        recordedFailure = true;
        try { this.balancer.failure(route, upstream); } catch {}
        clearAttempt();
        if (attempts < maxAttempts && !response.headersSent && !response.destroyed && !completed) {
          const retryCfg = route.config.retry || {};
          const backoff = computeBackoff(retryCfg.backoffMs ?? 25, attempts, retryCfg.jitterMs ?? 0);
          backoffTimer = setTimeout(attempt, backoff);
          return;
        }
        if (response.headersSent || response.destroyed) {
          finish();
          try { response.destroy(); } catch {}
          return;
        }
        terminate(502, 'Bad gateway');
      };

      const transport = destination.protocol === 'https:' ? httpsRequest : httpRequest;
      const outbound = transport(destination, {
        method,
        headers,
        agent: destination.protocol === 'https:' ? this.balancer.httpsAgent : this.balancer.httpAgent,
      }, incoming => {
        if (completed || response.headersSent || response.destroyed) {
          try { incoming.destroy(); } catch {}
          return;
        }
        headersReceived = true;
        try {
          if (response.headersSent || response.destroyed) {
            try { incoming.destroy(); } catch {}
            return;
          }
          const responseHeaders = sanitizeHeaders(incoming.headers);
          responseHeaders['x-request-id'] = requestId;
          response.writeHead(incoming.statusCode ?? 502, responseHeaders);
        } catch {
          try { incoming.destroy(); } catch {}
          return;
        }
        incoming.once('end', () => {
          if (!recordedFailure && !completed) {
            const durationMs = Date.now() - startTime;
            try { this.balancer.success(upstream); } catch {}
            try { (this.balancer as any).recordLatency?.(upstream, durationMs); } catch {}
            try {
              if (!response.destroyed) {
                (route.config as any).onRequestComplete?.({ requestId, method, path: requested.pathname, upstream: upstream.url, status: response.statusCode, durationMs });
              }
            } catch {}
          }
        });
        incoming.once('aborted', () => {
          if (recordedFailure || completed || clientAborted) return;
          try { this.balancer.failure(route, upstream); } catch {}
          recordedFailure = true;
          try { terminate(502, 'Incomplete upstream response'); } catch {}
        });
        incoming.once('error', () => {
          if (recordedFailure || completed || clientAborted) return;
          try { this.balancer.failure(route, upstream); } catch {}
          recordedFailure = true;
          try { terminate(502, 'Upstream stream failure'); } catch {}
        });
        try { incoming.pipe(response); } catch (e) { /* ignore */ }
      });
      currentRequest = outbound;
      activeTimer = setTimeout(() => {
        try {
          if (headersReceived || completed || response.headersSent || response.destroyed) return;
          outbound.destroy(new Error('Upstream timeout'));
        } catch {}
      }, timeouts.request);
      outbound.once('error', () => {
        if (completed || response.destroyed) return;
        if (!headersReceived) {
          try { fail(); } catch {}
          return;
        }
        if (clientAborted) return;
        if (!recordedFailure) {
          try { recordedFailure = true; this.balancer.failure(route, upstream); } catch {}
        }
        if (response.headersSent) {
          try { finish(); response.destroy(); } catch {}
        } else {
          try { terminate(502, 'Upstream connection failure'); } catch {}
        }
      });
      outbound.once('close', () => {
        if (completed || response.headersSent || response.destroyed) return;
        if (!headersReceived && !recordedFailure && !clientAborted) {
          try { fail(); } catch {}
        }
      });
      if (replayable) {
        try { outbound.end(); } catch {}
      } else {
        request.once('error', () => {
          try { outbound.destroy(); } catch {}
        });
        try { request.pipe(outbound); } catch {}
      }
    };

    response.once('finish', finish);
    response.once('close', () => {
      if (!response.writableEnded && !completed) {
        clientAborted = true;
        try { currentRequest?.destroy(); } catch {}
      }
      finish();
    });
    request.once('aborted', () => {
      clientAborted = true;
      try { currentRequest?.destroy(); } catch {}
      finish();
    });
    attempt();
  }

  private destination(requested: URL, route: RouteState, upstream: UpstreamState): URL {
    const destination = new URL(upstream.url);
    const prefixLength = route.path === '/' ? 0 : route.path.length;
    const pathname = route.config.stripPrefix
      ? (requested.pathname.slice(prefixLength) || '/')
      : requested.pathname;
    destination.pathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
    destination.search = requested.search;
    return destination;
  }

  private respond(response: ProxyResponse, status: number, message: string): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ statusCode: status, message }));
  }
}
