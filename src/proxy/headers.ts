import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

export function sanitizeHeaders(input: IncomingHttpHeaders): OutgoingHttpHeaders {
  const forbidden = new Set(HOP_BY_HOP);
  for (const header of String(input.connection ?? '').split(',')) {
    if (header.trim()) forbidden.add(header.trim().toLowerCase());
  }
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(input)) {
    if (!forbidden.has(name.toLowerCase()) && value !== undefined) result[name] = value;
  }
  return result;
}

export interface ForwardedHeaderOptions {
  /** When false, client-supplied forwarding metadata is discarded. */
  trustProxy: boolean;
  remoteAddress?: string;
  protocol: 'http' | 'https';
  /** Client Host header; omitted for HTTP/1.0 requests without one. */
  host?: string | string[];
}

function firstHeaderValue(value: string | string[] | number | undefined): string {
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  if (value === undefined) return '';
  return String(value).trim();
}

/**
 * Applies RFC 7239 removal rules plus X-Forwarded-* propagation in one place so the
 * HTTP/1 proxy and the WebSocket transport cannot drift apart. Empty values are never
 * emitted and an empty client chain never produces a leading comma.
 */
export function applyForwardedHeaders(headers: OutgoingHttpHeaders, options: ForwardedHeaderOptions): void {
  if (!options.trustProxy) {
    delete headers.forwarded;
    delete headers['x-forwarded-for'];
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
  }

  const existingFor = firstHeaderValue(headers['x-forwarded-for']);
  if (options.remoteAddress) {
    headers['x-forwarded-for'] = existingFor ? `${existingFor}, ${options.remoteAddress}` : options.remoteAddress;
  } else if (!existingFor) {
    delete headers['x-forwarded-for'];
  }

  const forwardedHost = firstHeaderValue(headers['x-forwarded-host']) || firstHeaderValue(options.host);
  if (forwardedHost) headers['x-forwarded-host'] = forwardedHost;
  else delete headers['x-forwarded-host'];

  const forwardedProto = firstHeaderValue(headers['x-forwarded-proto']);
  headers['x-forwarded-proto'] = options.trustProxy && forwardedProto ? forwardedProto : options.protocol;
}
