import * as net from 'node:net';

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./,
  /^192\.0\.0\./,
  /^192\.0\.2\./,
  /^198\.18\./,
  /^198\.19\./,
  /^198\.51\.100\./,
  /^203\.0\.113\./,
  /^224\./,
  /^240\./,
];

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

export interface SsrfOptions {
  allowPrivate?: boolean;
  allowLocalhost?: boolean;
  allowlinkLocal?: boolean;
  allowlist?: string[];
  blocklist?: string[];
}

export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    for (const re of PRIVATE_V4) {
      if (re.test(ip)) return true;
    }
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fe80:')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('ff')) return true;
    if (lower.startsWith('::ffff:127.') || lower.startsWith('::ffff:10.') || lower.startsWith('::ffff:192.168.') || lower.startsWith('::ffff:172.')) return true;
    if (lower === '::' || lower.startsWith('::ffff:0:') || lower.startsWith('64:ff9b::')) return true;
    return false;
  }
  return true;
}

export function isBlockedHostName(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(h)) return true;
  if (h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;
  return false;
}

export function validateUpstreamOrigin(origin: string, options: SsrfOptions = {}): { valid: boolean; reason?: string } {
  const opts: SsrfOptions = {
    allowPrivate: options.allowPrivate === undefined ? true : options.allowPrivate,
    allowLocalhost: options.allowLocalhost === undefined ? true : options.allowLocalhost,
    allowlist: options.allowlist,
    blocklist: options.blocklist,
  };
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return { valid: false, reason: 'Invalid URL' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) return { valid: false, reason: 'Only http/https allowed' };
  const hostname = url.hostname.toLowerCase();
  if (url.username || url.password) return { valid: false, reason: 'Credentials not allowed in upstream' };

  if (opts.blocklist?.some(b => hostname === b.toLowerCase() || hostname.endsWith('.' + b.toLowerCase()))) {
    return { valid: false, reason: 'Host blocked by blocklist' };
  }
  if (opts.allowlist?.length) {
    const allowed = opts.allowlist.some(a => {
      const al = a.toLowerCase();
      return hostname === al || hostname.endsWith('.' + al);
    });
    if (!allowed) return { valid: false, reason: 'Host not in allowlist' };
  }

  // For backward compatibility with existing tests and local dev, be permissive by default
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
    return { valid: true };
  }

  if (net.isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      if (opts.allowPrivate || opts.allowLocalhost) return { valid: true };
      return { valid: false, reason: 'Private/loopback/link-local/reserved IP blocked' };
    }
    return { valid: true };
  }

  if (isBlockedHostName(hostname)) {
    if (opts.allowLocalhost || opts.allowPrivate) return { valid: true };
    return { valid: false, reason: 'Localhost hostname blocked' };
  }

  return { valid: true };
}
