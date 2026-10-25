import type { BalancerStrategy, RouteState, UpstreamState } from '../types';
import * as crypto from 'node:crypto';

const registry = new Map<string, BalancerStrategy>();

export function registerStrategy(strategy: BalancerStrategy): void {
  if (!strategy.name || typeof strategy.select !== 'function') throw new Error('Invalid strategy');
  registry.set(strategy.name, strategy);
}

function hashString(value: string): number {
  const h = crypto.createHash('sha256').update(value).digest();
  return h.readUInt32BE(0);
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
    const h = hashString(key);
    const idx = h % available.length;
    // try to pick stable - also consider weight lightly
    return available[idx];
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
  return ['round-robin', 'weighted-round-robin', 'least-connections', 'random', 'least-response-time', 'consistent-hash'].includes(name) || registry.has(name);
}
