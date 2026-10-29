import * as net from 'node:net';

const PRIVATE_V4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE_V4.addSubnet(address, prefix, 'ipv4');
}

const PRIVATE_V6 = new net.BlockList();
for (const [address, prefix] of [
  ['::', 96],
  ['::1', 128],
  ['2001:db8::', 32],
  ['64:ff9b::', 96],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['::ffff:0:0', 96],
] as const) {
  PRIVATE_V6.addSubnet(address, prefix, 'ipv6');
}

const LOOPBACK = new net.BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addSubnet('::1', 128, 'ipv6');

const LINK_LOCAL = new net.BlockList();
LINK_LOCAL.addSubnet('169.254.0.0', 16, 'ipv4');
LINK_LOCAL.addSubnet('fe80::', 10, 'ipv6');

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

export interface SsrfOptions {
  allowPrivate?: boolean;
  allowLocalhost?: boolean;
  allowLinkLocal?: boolean;
  allowlinkLocal?: boolean;
  allowlist?: string[];
  blocklist?: string[];
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function normalizeHost(hostname: string): string {
  let host = stripBrackets(hostname.trim().toLowerCase());
  if (host.endsWith('.')) host = host.replace(/\.+$/, '');
  return host;
}

function hostMatches(hostname: string, entry: string): boolean {
  const pattern = normalizeHost(entry);
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    return suffix.length > 0 && (hostname === suffix || hostname.endsWith(`.${suffix}`));
  }
  return hostname === pattern;
}

function mappedV4(ip: string): string | undefined {
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (dotted) return dotted[1];
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function normalizeIp(ip: string): { address: string; family: 'ipv4' | 'ipv6' } | undefined {
  const bare = stripBrackets(ip).toLowerCase();
  const mapped = mappedV4(bare);
  if (mapped && net.isIPv4(mapped)) return { address: mapped, family: 'ipv4' };
  if (net.isIPv4(bare)) return { address: bare, family: 'ipv4' };
  if (net.isIPv6(bare)) return { address: bare, family: 'ipv6' };
  return undefined;
}

function belongs(list: net.BlockList, ip: { address: string; family: 'ipv4' | 'ipv6' }): boolean {
  return list.check(ip.address, ip.family);
}

export function isBlockedIp(ip: string): boolean {
  const normalized = normalizeIp(ip);
  if (!normalized) return true;
  return belongs(normalized.family === 'ipv4' ? PRIVATE_V4 : PRIVATE_V6, normalized);
}

export function isLoopbackIp(ip: string): boolean {
  const normalized = normalizeIp(ip);
  return normalized ? belongs(LOOPBACK, normalized) : false;
}

export function isLinkLocalIp(ip: string): boolean {
  const normalized = normalizeIp(ip);
  return normalized ? belongs(LINK_LOCAL, normalized) : false;
}

export function isBlockedHostName(hostname: string): boolean {
  const h = normalizeHost(hostname);
  if (BLOCKED_HOSTS.has(h)) return true;
  if (h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;
  return false;
}

function isLoopbackHostName(hostname: string): boolean {
  const h = normalizeHost(hostname);
  return BLOCKED_HOSTS.has(h) || h.endsWith('.localhost');
}

export function validateUpstreamOrigin(origin: string, options: SsrfOptions = {}): { valid: boolean; reason?: string } {
  const allowPrivate = options.allowPrivate === undefined ? true : options.allowPrivate;
  const opts: SsrfOptions = {
    allowPrivate,
    allowLocalhost: options.allowLocalhost === undefined ? allowPrivate : options.allowLocalhost,
    allowLinkLocal: options.allowLinkLocal === undefined ? (options.allowlinkLocal ?? false) : options.allowLinkLocal,
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
  const hostname = normalizeHost(url.hostname);
  if (!hostname) return { valid: false, reason: 'Invalid hostname' };
  if (url.username || url.password) return { valid: false, reason: 'Credentials not allowed in upstream' };

  if (opts.blocklist?.some(entry => hostMatches(hostname, entry))) {
    return { valid: false, reason: 'Host blocked by blocklist' };
  }
  if (opts.allowlist?.length) {
    const allowed = opts.allowlist.some(entry => hostMatches(hostname, entry));
    if (!allowed) return { valid: false, reason: 'Host not in allowlist' };
  }

  const normalized = normalizeIp(hostname);
  if (normalized) {
    if (!isBlockedIp(hostname)) return { valid: true };
    if (isLoopbackIp(hostname)) {
      return opts.allowLocalhost ? { valid: true } : { valid: false, reason: 'Loopback IP blocked' };
    }
    if (isLinkLocalIp(hostname)) {
      return opts.allowLinkLocal ? { valid: true } : { valid: false, reason: 'Link-local IP blocked' };
    }
    if (opts.allowPrivate) return { valid: true };
    return { valid: false, reason: 'Private/loopback/link-local/reserved IP blocked' };
  }

  if (isBlockedHostName(hostname)) {
    if (isLoopbackHostName(hostname)) {
      return opts.allowLocalhost ? { valid: true } : { valid: false, reason: 'Localhost hostname blocked' };
    }
    if (opts.allowPrivate) return { valid: true };
    return { valid: false, reason: 'Local hostname blocked' };
  }

  return { valid: true };
}
