import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RouteState, StickyOptions } from '../types';

const DEFAULT_TTL_MS = 3600000;
const SIGNATURE_LENGTH = 32;

function signature(secret: string, routePath: string, issuedAt: string, upstreamUrl: string): string {
  return createHmac('sha256', secret)
    .update(`${routePath}\n${issuedAt}\n${upstreamUrl}`)
    .digest('hex')
    .slice(0, SIGNATURE_LENGTH);
}

function equalSignature(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function getCookieValue(header: string | string[] | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const raw = Array.isArray(header) ? header.join(';') : header;
  const prefix = `${name}=`;
  for (const part of raw.split(';')) {
    const entry = part.trim();
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
  }
  return undefined;
}

export function resolveStickyUpstream(
  route: RouteState,
  cookieHeader: string | string[] | undefined,
  options: StickyOptions,
  secret: string,
): string | undefined {
  if (!options.cookie) return undefined;
  const raw = getCookieValue(cookieHeader, options.cookie);
  if (!raw) return undefined;

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }

  const separator = decoded.indexOf('.');
  if (separator <= 0) return undefined;
  const issuedAt = decoded.slice(0, separator);
  const provided = decoded.slice(separator + 1);
  const issuedMs = Number.parseInt(issuedAt, 36);
  if (!Number.isFinite(issuedMs) || issuedMs <= 0) return undefined;
  if (provided.length !== SIGNATURE_LENGTH) return undefined;

  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  if (ttlMs > 0 && Date.now() - issuedMs > ttlMs) return undefined;

  for (const node of route.upstreams) {
    const expected = signature(secret, route.path, issuedAt, node.url);
    if (equalSignature(provided, expected)) return node.url;
  }
  return undefined;
}

export function buildStickyCookie(
  route: RouteState,
  upstreamUrl: string,
  options: StickyOptions,
  secret: string,
): string {
  const issuedAt = Date.now().toString(36);
  const token = `${issuedAt}.${signature(secret, route.path, issuedAt, upstreamUrl)}`;
  const ttlMs = options.ttlMs === undefined ? DEFAULT_TTL_MS : options.ttlMs;
  const parts = [`${options.cookie}=${encodeURIComponent(token)}`];
  if (ttlMs > 0) parts.push(`Max-Age=${Math.max(0, Math.floor(ttlMs / 1000))}`);
  parts.push(`Path=${route.path === '/' ? '/' : route.path}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) {
    const sameSite = options.sameSite.charAt(0).toUpperCase() + options.sameSite.slice(1).toLowerCase();
    parts.push(`SameSite=${sameSite}`);
  }
  return parts.join('; ');
}
