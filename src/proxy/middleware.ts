import { Injectable, type NestMiddleware } from '@nestjs/common';
import { type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { TLSSocket } from 'node:tls';
import { randomBytes } from 'node:crypto';
import type { NextFunction } from 'express';
import { type CachedResponse, RequestInterceptionError, RouteBalancerService } from '../balancer.service';
import type { ProxyRequest, ProxyResponse, RateLimitDecision, RouteState, UpstreamState } from '../types';
import { applyForwardedHeaders, sanitizeHeaders } from './headers';
import { computeBackoff } from '../utils/backoff';
import { classifyError, type RetryReason } from '../utils/errors';
import { buildStickyCookie, resolveStickyUpstream } from '../utils/sticky';

// A client-controlled request id is echoed in responses and logs, so it must be a short
// printable token. Anything else is replaced instead of reflected verbatim.
const REQUEST_ID_PATTERN = /^[!-~]{1,128}$/;

function getRequestId(request: ProxyRequest): string {
  const existing = request.headers['x-request-id'];
  const candidate = Array.isArray(existing) ? existing[0] : existing;
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (REQUEST_ID_PATTERN.test(trimmed)) return trimmed;
  }
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

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, '');
}

function isHostAllowed(route: RouteState, hostHeader: string | undefined): boolean {
  const allowed = route.config.allowedHosts;
  if (!allowed || allowed.length === 0) return true;
  if (!hostHeader || /[@/\\]/.test(hostHeader)) return false;
  let host: string;
  try {
    host = normalizeHost(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
  return allowed.some(entry => {
    const candidate = normalizeHost(entry.trim());
    if (candidate.startsWith('*.')) {
      const root = candidate.slice(2);
      return host === root || host.endsWith(`.${root}`);
    }
    return host === candidate;
  });
}

const DEFAULT_CACHE_STATUSES = [200, 203, 204, 301, 308];
const DEFAULT_MAX_ENTRY_BYTES = 1_048_576;

function headerValue(headers: IncomingMessage['headers'], name: string): string {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw.join(',').trim();
  return (raw ?? '').trim();
}

function parseCacheControl(value: string | string[] | undefined): Map<string, string> {
  const directives = new Map<string, string>();
  const raw = Array.isArray(value) ? value.join(',') : value ?? '';
  for (const part of raw.split(',')) {
    const [name, ...rest] = part.trim().split('=');
    if (name) directives.set(name.toLowerCase(), rest.join('=').replace(/^"|"$/g, ''));
  }
  return directives;
}

function requestBypassesCache(headers: IncomingMessage['headers']): boolean {
  if (headers.authorization !== undefined || headers.cookie !== undefined) return true;
  if (headers.range !== undefined) return true;
  const cacheControl = parseCacheControl(headers['cache-control']);
  return cacheControl.has('no-store') || cacheControl.has('no-cache');
}

/** Returns the TTL allowed by the response, or undefined when it must not be stored. */
function responseCacheTtl(
  route: RouteState,
  status: number,
  headers: IncomingMessage['headers'],
  allowedVary: readonly string[],
): number | undefined {
  const cache = route.config.cache;
  if (!cache) return undefined;
  if (!(cache.statuses ?? DEFAULT_CACHE_STATUSES).includes(status)) return undefined;
  if (headers['set-cookie'] !== undefined) return undefined;

  const cacheControl = parseCacheControl(headers['cache-control']);
  if (cacheControl.has('no-store') || cacheControl.has('private') || cacheControl.has('no-cache')) return undefined;

  const varyNames = headerValue(headers, 'vary').split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
  if (varyNames.includes('*')) return undefined;
  if (varyNames.some(name => !allowedVary.includes(name))) return undefined;

  let ttlMs = cache.ttlMs;
  for (const directive of ['s-maxage', 'max-age']) {
    const raw = cacheControl.get(directive);
    if (raw === undefined) continue;
    const seconds = Number.parseInt(raw, 10);
    if (Number.isFinite(seconds)) ttlMs = Math.min(ttlMs, seconds * 1000);
  }
  return ttlMs > 0 ? ttlMs : undefined;
}

function mergeSetCookie(headers: OutgoingHttpHeaders, cookie: string | undefined): void {
  if (!cookie) return;
  const existing = headers['set-cookie'];
  const values = existing === undefined ? [] : Array.isArray(existing) ? [...existing] : [String(existing)];
  values.push(cookie);
  headers['set-cookie'] = values;
}

/** HTTP/1.1 streaming transport. Upgrade (WebSocket) and HTTP/2 require separate adapters. */
@Injectable()
export class RouteBalancerMiddleware implements NestMiddleware {
  constructor(private readonly balancer: RouteBalancerService) {}

  async use(request: ProxyRequest, response: ProxyResponse, next: NextFunction): Promise<void> {
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
    const requestId = getRequestId(request);
    if (this.balancer.isShuttingDown()) {
      this.respond(response, 503, 'Server shutting down', requestId);
      return;
    }
    if (!isHostAllowed(route, request.headers.host)) {
      this.respond(response, 421, 'Misdirected request', requestId);
      return;
    }

    // Local token bucket: reject before running plugins or acquiring an upstream.
    const rateLimit = this.balancer.checkRateLimit(route, request.socket.remoteAddress, request.headers);
    if (rateLimit && !rateLimit.allowed) {
      this.respond(response, 429, 'Rate limit exceeded', requestId, {
        'ratelimit-limit': rateLimit.limit,
        'ratelimit-remaining': rateLimit.remaining,
        'ratelimit-reset': rateLimit.resetSeconds,
        'retry-after': String(rateLimit.retryAfterSeconds ?? 1),
      });
      return;
    }

    const lifecycle = this.balancer.registerRequest();
    const abortInterception = (): void => lifecycle.abort();
    const onInterceptionResponseClose = (): void => {
      if (!response.writableEnded) lifecycle.abort();
    };
    request.once('aborted', abortInterception);
    response.once('close', onInterceptionResponseClose);
    try {
      const headers = Object.fromEntries(Object.entries(request.headers).filter(
        (entry): entry is [string, string | string[]] => typeof entry[1] === 'string' || Array.isArray(entry[1]),
      ));
      const interception = await this.balancer.interceptRequest(route, {
        requestId,
        method,
        pathname: requested.pathname,
        query: requested.search,
        headers,
      }, lifecycle.signal);
      if (response.destroyed || lifecycle.signal.aborted) {
        lifecycle.done();
        return;
      }
      requested.pathname = interception.pathname;
      const interceptedHeaders = { ...request.headers };
      for (const [name, value] of Object.entries(interception.headers)) {
        if (value === null) delete interceptedHeaders[name];
        else interceptedHeaders[name] = value;
      }
      request.headers = interceptedHeaders;
    } catch (error) {
      lifecycle.done();
      if (!response.destroyed && !response.headersSent) {
        const status = error instanceof RequestInterceptionError ? error.statusCode : 500;
        const message = error instanceof RequestInterceptionError ? error.message : 'Request interception failed';
        this.respond(response, status, message, requestId);
      }
      return;
    } finally {
      request.off('aborted', abortInterception);
      response.off('close', onInterceptionResponseClose);
    }

    const retryConfig = route.config.retry;
    const permitted = (retryConfig?.methods ?? ['GET', 'HEAD']).map(value => value.toUpperCase());
    // Retries cannot replay request streams and must never duplicate arbitrary mutations.
    const replayable = (method === 'GET' || method === 'HEAD')
      && permitted.includes(method)
      && request.headers['content-length'] === undefined
      && request.headers['transfer-encoding'] === undefined;
    const maxAttempts = replayable ? 1 + (retryConfig?.attempts ?? 0) : 1;
    const excluded = new Set<string>();
    const timeouts = resolveTimeouts(route);
    const sticky = route.config.sticky;
    const stickySecret = sticky?.secret ?? this.balancer.defaultStickySecret;
    const preferred = sticky?.cookie
      ? resolveStickyUpstream(route, request.headers.cookie, sticky, stickySecret)
      : undefined;
    const selectionRequest = {
      socket: request.socket,
      ip: (request as ProxyRequest & { ip?: string }).ip,
      originalUrl: `${requested.pathname}${requested.search}`,
      url: `${requested.pathname}${requested.search}`,
      headers: request.headers,
    };
    const startTime = Date.now();

    let currentRequest: ClientRequest | undefined;
    let currentIncoming: IncomingMessage | undefined;
    let currentUpstream: UpstreamState | undefined;
    let pendingCookie: string | undefined;
    let headerTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    let connectTimer: NodeJS.Timeout | undefined;
    let backoffTimer: NodeJS.Timeout | undefined;
    let completed = false;
    let clientAborted = false;
    let attempts = 0;
    let cacheKey: string | undefined;
    let cacheVary: string[] = [];
    let cacheContext: { key: string; vary: string[] } | undefined;
    let cacheFillStarted = false;

    const clearTimers = (): void => {
      for (const timer of [headerTimer, totalTimer, idleTimer, connectTimer]) {
        if (timer) clearTimeout(timer);
      }
      headerTimer = undefined;
      totalTimer = undefined;
      idleTimer = undefined;
      connectTimer = undefined;
    };

    const clearAttempt = (destroy = false): void => {
      clearTimers();
      if (destroy) {
        try { currentIncoming?.destroy(); } catch {}
        try { currentRequest?.destroy(); } catch {}
      }
      if (currentUpstream) this.balancer.release(currentUpstream, route);
      currentIncoming = undefined;
      currentRequest = undefined;
      currentUpstream = undefined;
      pendingCookie = undefined;
    };

    let onShutdown: () => void = () => {};

    const finish = (): void => {
      if (completed) return;
      completed = true;
      if (cacheFillStarted) {
        cacheFillStarted = false;
        if (cacheKey) this.balancer.endCacheFill(cacheKey);
      }
      if (backoffTimer) clearTimeout(backoffTimer);
      backoffTimer = undefined;
      clearAttempt();
      lifecycle.signal.removeEventListener('abort', onShutdown);
      lifecycle.done();
    };

    const terminate = (status: number, message: string): void => {
      if (completed) return;
      if (response.headersSent) {
        finish();
        try { response.destroy(); } catch {}
        return;
      }
      finish();
      try { this.respond(response, status, message, requestId); } catch {}
    };

    onShutdown = (): void => {
      if (completed) return;
      clientAborted = true;
      try { currentIncoming?.destroy(); } catch {}
      try { currentRequest?.destroy(); } catch {}
      terminate(503, 'Server shutting down');
    };
    lifecycle.signal.addEventListener('abort', onShutdown, { once: true });

    response.once('finish', finish);
    response.once('close', () => {
      if (!response.writableEnded && !completed) {
        clientAborted = true;
        try { currentIncoming?.destroy(); } catch {}
        try { currentRequest?.destroy(); } catch {}
      }
      finish();
    });
    request.once('aborted', () => {
      clientAborted = true;
      try { currentIncoming?.destroy(); } catch {}
      try { currentRequest?.destroy(); } catch {}
      finish();
    });
    request.once('error', () => {
      try { currentRequest?.destroy(); } catch {}
    });

    const cacheConfig = route.config.cache;
    if (cacheConfig) {
      if (method === 'GET' || method === 'HEAD') {
        if (!requestBypassesCache(request.headers)) {
          cacheContext = this.balancer.cacheContextFor(route, method, requested.pathname, requested.search, request.headers);
        }
        if (cacheContext) {
          const cached = this.balancer.getCached(route, cacheContext.key);
          if (cached) {
            this.serveCached(response, cached, requestId, rateLimit);
            finish();
            return;
          }
          if (!this.balancer.beginCacheFill(cacheContext.key)) {
            // Another request is filling this key; reuse its result when available.
            await this.balancer.awaitCacheFill(cacheContext.key, timeouts.request);
            if (completed || clientAborted || response.destroyed) {
              finish();
              return;
            }
            const late = this.balancer.getCached(route, cacheContext.key);
            if (late) {
              this.serveCached(response, late, requestId, rateLimit);
              finish();
              return;
            }
            cacheContext = undefined;
          } else {
            cacheKey = cacheContext.key;
            cacheVary = cacheContext.vary;
            cacheFillStarted = true;
          }
        }
      } else {
        // Unsafe methods invalidate cached variants for the rewritten pathname.
        this.balancer.invalidateCache(route, requested.pathname);
      }
    }


    const attempt = (): void => {
      if (completed || response.destroyed) return;
      const upstream = this.balancer.acquire(route, excluded, selectionRequest, preferred);
      if (!upstream) {
        terminate(attempts ? 502 : 503, attempts ? 'No remaining healthy upstream' : 'No healthy upstream available');
        return;
      }
      attempts += 1;
      excluded.add(upstream.url);
      currentUpstream = upstream;
      pendingCookie = sticky?.cookie ? buildStickyCookie(route, upstream.url, sticky, stickySecret) : undefined;

      const destination = this.destination(requested, route, upstream);
      const headers = sanitizeHeaders(request.headers);
      if (route.config.changeOrigin ?? true) headers.host = destination.host;
      // Untrusted client forwarded headers must not be forwarded or treated as authoritative.
      applyForwardedHeaders(headers, {
        trustProxy: this.balancer.options.trustProxy ?? false,
        remoteAddress: request.socket.remoteAddress,
        protocol: request.socket instanceof TLSSocket && request.socket.encrypted ? 'https' : 'http',
        host: request.headers.host,
      });
      headers['x-request-id'] = requestId;

      const attemptStartedAt = Date.now();
      let headersReceived = false;
      let upstreamEnded = false;
      let recordedFailure = false;

      const fail = (reason: RetryReason): void => {
        if (recordedFailure || completed || clientAborted) return;
        recordedFailure = true;
        try { this.balancer.failure(route, upstream); } catch {}
        clearAttempt(true);
        const retryOn = retryConfig?.retryOn;
        const policyAllows = !retryOn || retryOn.includes(reason);
        if (
          attempts < maxAttempts
          && policyAllows
          && !response.headersSent
          && !response.destroyed
          && !completed
          && this.balancer.tryReserveRetry(route)
        ) {
          this.balancer.noteRetry(upstream);
          const backoff = computeBackoff(
            retryConfig?.backoffMs ?? 25,
            attempts,
            retryConfig?.jitterMs ?? 0,
            retryConfig?.maxBackoffMs,
          );
          backoffTimer = setTimeout(attempt, backoff);
          backoffTimer.unref?.();
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
        currentIncoming = incoming;
        if (headerTimer) {
          clearTimeout(headerTimer);
          headerTimer = undefined;
        }
        let upstreamHeaders: OutgoingHttpHeaders = {};
        let cacheTtl: number | undefined;
        try {
          if (response.headersSent || response.destroyed) {
            try { incoming.destroy(); } catch {}
            return;
          }
          upstreamHeaders = sanitizeHeaders(incoming.headers);
          const responseHeaders = { ...upstreamHeaders };
          responseHeaders['x-request-id'] = requestId;
          if (rateLimit) {
            responseHeaders['ratelimit-limit'] = rateLimit.limit;
            responseHeaders['ratelimit-remaining'] = rateLimit.remaining;
            responseHeaders['ratelimit-reset'] = rateLimit.resetSeconds;
          }
          if (cacheContext) {
            cacheTtl = responseCacheTtl(route, incoming.statusCode ?? 0, incoming.headers, cacheVary);
            responseHeaders['x-cache'] = cacheTtl === undefined ? 'BYPASS' : 'MISS';
          }
          mergeSetCookie(responseHeaders, pendingCookie);
          response.writeHead(incoming.statusCode ?? 502, responseHeaders);
        } catch {
          try { incoming.destroy(); } catch {}
          terminate(502, 'Bad gateway');
          return;
        }

        const armIdle = (): void => {
          if (idleTimer) clearTimeout(idleTimer);
          if (timeouts.idle <= 0 || completed || upstreamEnded) return;
          idleTimer = setTimeout(() => {
            if (completed || upstreamEnded) return;
            try { outbound.destroy(Object.assign(new Error('Upstream idle timeout'), { code: 'EIDLETIMEOUT' })); } catch {}
          }, timeouts.idle);
          idleTimer.unref?.();
        };
        armIdle();
        incoming.on('data', armIdle);

        // Buffer a bounded copy while streaming, so cache hits do not break streaming.
        const cacheChunks: Buffer[] = [];
        let cacheBytes = 0;
        let cacheAbandoned = cacheContext === undefined || cacheTtl === undefined;
        const maxEntryBytes = cacheConfig?.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
        if (!cacheAbandoned) {
          incoming.on('data', (chunk: Buffer) => {
            if (cacheAbandoned) return;
            cacheBytes += chunk.length;
            if (cacheBytes > maxEntryBytes) {
              cacheAbandoned = true;
              cacheChunks.length = 0;
              return;
            }
            cacheChunks.push(chunk);
          });
        }

        incoming.once('end', () => {
          upstreamEnded = true;
          incoming.off('data', armIdle);
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = undefined;
          }
          if (totalTimer) {
            clearTimeout(totalTimer);
            totalTimer = undefined;
          }
          if (!recordedFailure && !completed) {
            const durationMs = Date.now() - startTime;
            const attemptDurationMs = Date.now() - attemptStartedAt;
            const status = incoming.statusCode ?? 0;
            try { this.balancer.success(upstream, route); } catch {}
            try { this.balancer.observeStatus(route, upstream, status); } catch {}
            // Adaptive strategies must see this attempt only, not retries and backoff.
            try { this.balancer.recordLatency(upstream, attemptDurationMs); } catch {}
            try {
              if (!response.destroyed) {
                route.config.onRequestComplete?.({
                  requestId,
                  method,
                  path: requested.pathname,
                  upstream: upstream.url,
                  status: response.statusCode,
                  durationMs,
                });
              }
            } catch {}
          }

          if (!recordedFailure && !completed && cacheContext && !cacheAbandoned && cacheTtl !== undefined) {
            this.balancer.storeCache(route, {
              key: cacheContext.key,
              pathname: requested.pathname,
              head: method === 'HEAD',
            }, {
              status: incoming.statusCode ?? 0,
              headers: upstreamHeaders,
              body: Buffer.concat(cacheChunks, cacheBytes),
              ttlMs: cacheTtl,
            });
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
        try { incoming.pipe(response); } catch { /* the response close handler releases the attempt */ }
      });

      currentRequest = outbound;

      outbound.once('socket', socket => {
        if (!socket.connecting || timeouts.connect <= 0) return;
        connectTimer = setTimeout(() => {
          if (completed) return;
          try { outbound.destroy(Object.assign(new Error('Upstream connect timeout'), { code: 'ECONNECTTIMEOUT' })); } catch {}
        }, timeouts.connect);
        connectTimer.unref?.();
        socket.once('connect', () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = undefined;
          }
        });
        socket.once('close', () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = undefined;
          }
        });
      });

      if (timeouts.headers > 0) {
        headerTimer = setTimeout(() => {
          if (headersReceived || completed || response.headersSent || response.destroyed) return;
          try { outbound.destroy(Object.assign(new Error('Upstream headers timeout'), { code: 'ETIMEDOUT' })); } catch {}
        }, timeouts.headers);
        headerTimer.unref?.();
      }

      if (timeouts.request > 0) {
        totalTimer = setTimeout(() => {
          if (completed || upstreamEnded) return;
          try { outbound.destroy(Object.assign(new Error('Upstream request timeout'), { code: 'EREQUESTTIMEOUT' })); } catch {}
        }, timeouts.request);
        totalTimer.unref?.();
      }

      outbound.once('error', error => {
        if (completed || response.destroyed) return;
        if (clientAborted) return;
        if (!headersReceived) {
          fail(classifyError(error));
          return;
        }
        if (!recordedFailure) {
          recordedFailure = true;
          try { this.balancer.failure(route, upstream); } catch {}
        }
        if (response.headersSent) {
          finish();
          try { response.destroy(); } catch {}
        } else {
          terminate(502, 'Upstream connection failure');
        }
      });
      outbound.once('close', () => {
        if (completed || response.headersSent || response.destroyed) return;
        if (!headersReceived && !recordedFailure && !clientAborted) fail('network');
      });

      if (replayable) {
        try { outbound.end(); } catch {}
      } else {
        try { request.pipe(outbound); } catch {}
      }
    }

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

  private serveCached(
    response: ProxyResponse,
    entry: CachedResponse,
    requestId: string,
    rateLimit: RateLimitDecision | undefined,
  ): void {
    const headers: OutgoingHttpHeaders = { ...entry.headers };
    headers['x-cache'] = 'HIT';
    headers.age = String(Math.max(0, Math.floor((Date.now() - entry.storedAt) / 1000)));
    headers['x-request-id'] = requestId;
    if (rateLimit) {
      headers['ratelimit-limit'] = rateLimit.limit;
      headers['ratelimit-remaining'] = rateLimit.remaining;
      headers['ratelimit-reset'] = rateLimit.resetSeconds;
    }
    if (!entry.head && entry.body.length > 0) headers['content-length'] = entry.body.length;
    response.writeHead(entry.status, headers);
    response.end(entry.head ? undefined : entry.body);
  }

  private respond(
    response: ProxyResponse,
    status: number,
    message: string,
    requestId?: string,
    extraHeaders?: OutgoingHttpHeaders,
  ): void {
    const body = JSON.stringify({ statusCode: status, message });
    const headers: OutgoingHttpHeaders = {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      // Synthetic gateway errors must not be cached or reused by intermediaries.
      'cache-control': 'no-store',
    };
    if (requestId) headers['x-request-id'] = requestId;
    if (this.balancer.isShuttingDown()) headers.connection = 'close';
    if (extraHeaders) Object.assign(headers, extraHeaders);
    response.writeHead(status, headers);
    response.end(body);
  }
}
