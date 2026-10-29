import type { BalancerStrategy, RouteState, UpstreamState } from '../types';
import * as crypto from 'node:crypto';

/** Janela de decaimento da latência observada usada pelas estratégias adaptativas. */
const ADAPTIVE_DECAY_MS = 10000;

const registry = new Map<string, BalancerStrategy>();

export function registerStrategy(strategy: BalancerStrategy): void {
  if (!strategy.name || typeof strategy.select !== 'function') throw new Error('Invalid strategy');
  registry.set(strategy.name, strategy);
}

function hashString(value: string): number {
  const h = crypto.createHash('sha256').update(value).digest();
  return h.readUInt32BE(0);
}

interface RingEntry {
  hash: number;
  node: UpstreamState;
}

interface RingCache {
  signature: string;
  ring: RingEntry[];
}

const rings = new WeakMap<RouteState, RingCache>();

function buildRing(available: UpstreamState[]): RingEntry[] {
  const ring: RingEntry[] = [];
  for (const node of available) {
    const virtualNodes = Math.max(1, Math.min(2000, Math.round(node.weight * 40)));
    for (let index = 0; index < virtualNodes; index += 1) {
      ring.push({ hash: hashString(`${node.url}#${index}`), node });
    }
  }
  return ring.sort((a, b) => a.hash - b.hash);
}

function selectFromRing(route: RouteState, available: UpstreamState[], key: string): UpstreamState {
  const signature = available.map(node => `${node.url}:${node.weight}`).join('|');
  let cache = rings.get(route);
  if (!cache || cache.signature !== signature) {
    cache = { signature, ring: buildRing(available) };
    rings.set(route, cache);
  }
  const ring = cache.ring;
  if (ring.length === 0) return available[route.cursor++ % available.length];

  const hash = hashString(key);
  let low = 0;
  let high = ring.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (ring[mid].hash >= hash) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  if (low >= ring.length) found = 0;
  return ring[found].node;
}

function latencyScore(node: UpstreamState, now: number): number {
  // Um nó sem amostra recente fica com score neutro para receber uma primeira requisição.
  if (!node.ewmaResponseTimeMs || node.ewmaResponseTimeMs <= 0) return 0;
  const observedAt = node.ewmaObservedAt || now;
  const age = Math.max(0, now - observedAt);
  const decayed = node.ewmaResponseTimeMs * Math.exp(-age / ADAPTIVE_DECAY_MS);
  const load = 1 + Math.max(0, node.active);
  return (decayed * load) / Math.max(1, node.weight);
}

function selectLeastScore(route: RouteState, available: UpstreamState[], now: number): UpstreamState {
  let bestScore = Infinity;
  for (const node of available) bestScore = Math.min(bestScore, latencyScore(node, now));
  const tied = available.filter(node => Math.abs(latencyScore(node, now) - bestScore) <= 1e-9);
  return tied[route.cursor++ % tied.length];
}

function selectPowerOfTwo(route: RouteState, available: UpstreamState[], now: number): UpstreamState {
  if (available.length === 1) return available[0];
  const first = Math.floor(Math.random() * available.length);
  let second = Math.floor(Math.random() * (available.length - 1));
  if (second >= first) second += 1;
  const a = available[first];
  const b = available[second];
  const scoreA = latencyScore(a, now);
  const scoreB = latencyScore(b, now);
  if (Math.abs(scoreA - scoreB) <= 1e-9) {
    const loadA = a.active / Math.max(1, a.weight);
    const loadB = b.active / Math.max(1, b.weight);
    if (loadA !== loadB) return loadA < loadB ? a : b;
    return route.cursor++ % 2 === 0 ? a : b;
  }
  return scoreA < scoreB ? a : b;
}

function getHashKey(route: RouteState, request?: any): string {
  const cfg: any = route.config || {};
  const keyType = cfg.hashKey || 'ip';
  if (keyType === 'ip') {
    return request?.socket?.remoteAddress || request?.ip || '0.0.0.0';
  }
  if (keyType === 'path') {
    return request?.originalUrl || request?.url || '/';
  }
  if (keyType === 'header' && cfg.hashHeader) {
    const h = request?.headers?.[cfg.hashHeader.toLowerCase()];
    if (Array.isArray(h)) return h[0] || '';
    if (typeof h === 'string') return h;
    return '';
  }
  if (typeof keyType === 'string' && keyType !== 'ip' && keyType !== 'path') {
    // custom key from config
    return String((cfg as any)[keyType] || request?.[keyType] || '');
  }
  return request?.socket?.remoteAddress || '0.0.0.0';
}

export function selectUpstream(
  route: RouteState,
  available = route.upstreams.filter((node) => node.healthy),
  request?: any,
): UpstreamState | undefined {
  if (!available.length) return undefined;
  const algorithm = route.config.strategy ?? 'round-robin';
  const custom = registry.get(algorithm);
  if (custom) {
    const selected = custom.select(route, available);
    if (selected && !available.includes(selected)) throw new Error(`Strategy ${algorithm} selected an unavailable upstream`);
    return selected;
  }
  if (algorithm === 'random') return available[Math.floor(Math.random() * available.length)];
  if (algorithm === 'least-connections') {
    const minimum = Math.min(...available.map((node) => node.active / Math.max(1, node.weight)));
    const tied = available.filter((node) => node.active / Math.max(1, node.weight) === minimum);
    return tied[route.cursor++ % tied.length];
  }
  if (algorithm === 'peak-ewma') return selectLeastScore(route, available, Date.now());
  if (algorithm === 'p2c') return selectPowerOfTwo(route, available, Date.now());
  if (algorithm === 'least-response-time') {
    let best: UpstreamState | undefined;
    for (const node of available) {
      if (!best) { best = node; continue; }
      const b = best.ewmaResponseTimeMs || best.totalResponseTimeMs / Math.max(1, best.responseCount) || 0;
      const n = node.ewmaResponseTimeMs || node.totalResponseTimeMs / Math.max(1, node.responseCount) || 0;
      if (n < b - 0.001) best = node;
      else if (Math.abs(n - b) < 0.001) {
        if ((node.active / Math.max(1, node.weight)) < (best.active / Math.max(1, best.weight))) best = node;
      }
    }
    return best;
  }
  if (algorithm === 'consistent-hash') {
    const key = getHashKey(route, request);
    if (!key) return available[route.cursor++ % available.length];
    return selectFromRing(route, available, key);
  }
  if (algorithm === 'weighted-round-robin') {
    const total = available.reduce((sum, node) => sum + node.weight, 0);
    let best: UpstreamState | undefined;
    for (const node of available) {
      node.currentWeight += node.weight;
      if (!best || node.currentWeight > best.currentWeight) best = node;
    }
    if (best) best.currentWeight -= total;
    return best;
  }
  if (algorithm !== 'round-robin') throw new Error(`Unknown strategy: ${algorithm}`);
  return available[route.cursor++ % available.length];
}
export function hasStrategy(name: string): boolean {
  return ['round-robin', 'weighted-round-robin', 'least-connections', 'random', 'least-response-time', 'peak-ewma', 'p2c', 'consistent-hash'].includes(name) || registry.has(name);
}
