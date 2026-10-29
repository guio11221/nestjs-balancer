'use strict';

// Fluxo: rate limit local. Nenhum socket é aberto; o relógio é controlado.

const test = require('node:test');
const assert = require('node:assert/strict');

const { RouteBalancerService } = require('../../dist/index.js');

const A = 'http://127.0.0.1:3001';
const B = 'http://127.0.0.1:3002';

function createService(routes, extra = {}) {
  return new RouteBalancerService({ routes, ...extra });
}

test('token bucket allows the limit then rejects with retry information', () => {
  const realNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  const service = createService([{ path: '/api', upstreams: [A], rateLimit: { limit: 2, windowMs: 1000 } }]);
  const route = service.findRoute('/api');

  try {
    let decision = service.checkRateLimit(route, '10.0.0.1', {});
    assert.equal(decision.allowed, true);
    assert.equal(decision.limit, 2);
    assert.equal(decision.remaining, 1);
    assert.equal(decision.resetSeconds, 1);
    assert.equal(decision.retryAfterSeconds, undefined);

    decision = service.checkRateLimit(route, '10.0.0.1', {});
    assert.equal(decision.allowed, true);
    assert.equal(decision.remaining, 0);

    decision = service.checkRateLimit(route, '10.0.0.1', {});
    assert.equal(decision.allowed, false);
    assert.equal(decision.remaining, 0);
    assert.equal(decision.retryAfterSeconds, 1);
    assert.equal(route.rateLimited, 1);

    // Two tokens per second: half a window refills one token.
    now += 250;
    assert.equal(service.checkRateLimit(route, '10.0.0.1', {}).allowed, false);

    now += 250;
    decision = service.checkRateLimit(route, '10.0.0.1', {});
    assert.equal(decision.allowed, true, 'a partially refilled bucket must allow a new request');
  } finally {
    Date.now = realNow;
    service.onModuleDestroy();
  }
});

test('buckets are isolated by client address and by route', () => {
  const service = createService([
    { path: '/a', upstreams: [A], rateLimit: { limit: 1, windowMs: 60_000 } },
    { path: '/b', upstreams: [A], rateLimit: { limit: 1, windowMs: 60_000 } },
  ]);
  const a = service.findRoute('/a');
  const b = service.findRoute('/b');

  assert.equal(service.checkRateLimit(a, '10.0.0.1', {}).allowed, true);
  assert.equal(service.checkRateLimit(a, '10.0.0.1', {}).allowed, false);
  assert.equal(service.checkRateLimit(b, '10.0.0.1', {}).allowed, true, 'routes keep separate buckets by default');
  assert.equal(service.checkRateLimit(a, '10.0.0.2', {}).allowed, true, 'clients keep separate buckets');

  service.onModuleDestroy();
});

test('header keys isolate clients and fall back to the peer address', () => {
  const service = createService([
    { path: '/api', upstreams: [A], rateLimit: { limit: 1, windowMs: 60_000, key: 'header', header: 'x-api-key' } },
  ]);
  const route = service.findRoute('/api');

  assert.equal(service.checkRateLimit(route, '10.0.0.1', { 'x-api-key': 'key-1' }).allowed, true);
  assert.equal(service.checkRateLimit(route, '10.0.0.1', { 'x-api-key': 'key-1' }).allowed, false);
  assert.equal(service.checkRateLimit(route, '10.0.0.1', { 'x-api-key': 'key-2' }).allowed, true);

  assert.equal(service.checkRateLimit(route, '10.0.0.9', {}).allowed, true, 'missing header falls back to the peer');
  assert.equal(service.checkRateLimit(route, '10.0.0.9', {}).allowed, false);

  service.onModuleDestroy();
});

test('perRoute false shares one bucket across routes', () => {
  const service = createService([
    { path: '/a', upstreams: [A], rateLimit: { limit: 1, windowMs: 60_000, perRoute: false } },
    { path: '/b', upstreams: [B], rateLimit: { limit: 1, windowMs: 60_000, perRoute: false } },
  ]);

  assert.equal(service.checkRateLimit(service.findRoute('/a'), '10.0.0.1', {}).allowed, true);
  assert.equal(service.checkRateLimit(service.findRoute('/b'), '10.0.0.1', {}).allowed, false);

  service.onModuleDestroy();
});

test('maxKeys bounds memory by evicting the least recently used bucket', () => {
  const service = createService([
    { path: '/api', upstreams: [A], rateLimit: { limit: 1, windowMs: 60_000, maxKeys: 1 } },
  ]);
  const route = service.findRoute('/api');

  assert.equal(service.checkRateLimit(route, '10.0.0.1', {}).allowed, true);
  assert.equal(service.checkRateLimit(route, '10.0.0.1', {}).allowed, false);
  assert.equal(service.checkRateLimit(route, '10.0.0.2', {}).allowed, true, 'new keys evict the oldest bucket');
  assert.equal(service.checkRateLimit(route, '10.0.0.1', {}).allowed, true, 'evicted clients start a fresh bucket');

  service.onModuleDestroy();
});

test('trustProxy controls whether X-Forwarded-For scopes the identity', () => {
  const trusted = createService(
    [{ path: '/api', upstreams: [A], rateLimit: { limit: 1, windowMs: 60_000 } }],
    { trustProxy: true },
  );
  const trustedRoute = trusted.findRoute('/api');
  assert.equal(trusted.checkRateLimit(trustedRoute, '10.0.0.1', { 'x-forwarded-for': '1.1.1.1' }).allowed, true);
  assert.equal(trusted.checkRateLimit(trustedRoute, '10.0.0.1', { 'x-forwarded-for': '2.2.2.2' }).allowed, true);
  assert.equal(trusted.checkRateLimit(trustedRoute, '10.0.0.1', { 'x-forwarded-for': '1.1.1.1' }).allowed, false);
  trusted.onModuleDestroy();

  const untrusted = createService([{ path: '/api', upstreams: [A], rateLimit: { limit: 1, windowMs: 60_000 } }]);
  const untrustedRoute = untrusted.findRoute('/api');
  assert.equal(untrusted.checkRateLimit(untrustedRoute, '10.0.0.1', { 'x-forwarded-for': '1.1.1.1' }).allowed, true);
  assert.equal(untrusted.checkRateLimit(untrustedRoute, '10.0.0.1', { 'x-forwarded-for': '2.2.2.2' }).allowed, false);
  untrusted.onModuleDestroy();
});

test('resetRateLimits and route reloads discard existing buckets', () => {
  const service = createService([{ path: '/api', upstreams: [A], rateLimit: { limit: 1, windowMs: 60_000 } }]);
  const route = service.findRoute('/api');

  assert.equal(service.checkRateLimit(route, '10.0.0.1', {}).allowed, true);
  assert.equal(service.checkRateLimit(route, '10.0.0.1', {}).allowed, false);
  service.resetRateLimits();
  assert.equal(service.checkRateLimit(route, '10.0.0.1', {}).allowed, true);

  assert.equal(service.checkRateLimit(route, '10.0.0.1', {}).allowed, false);
  service.reloadRoutes({ routes: [{ path: '/api', upstreams: [A], rateLimit: { limit: 1, windowMs: 60_000 } }] });
  assert.equal(service.checkRateLimit(service.findRoute('/api'), '10.0.0.1', {}).allowed, true);

  service.onModuleDestroy();
});

test('rate limit configuration is validated', () => {
  const cases = [
    { limit: 0, windowMs: 1000 },
    { limit: 1.5, windowMs: 1000 },
    { limit: 1, windowMs: 9 },
    { limit: 1, windowMs: 1000, key: 'cookie' },
    { limit: 1, windowMs: 1000, key: 'header' },
    { limit: 1, windowMs: 1000, header: 'bad header' },
    { limit: 1, windowMs: 1000, perRoute: 'yes' },
    { limit: 1, windowMs: 1000, maxKeys: 0 },
  ];
  for (const rateLimit of cases) {
    assert.throws(
      () => createService([{ path: '/api', upstreams: [A], rateLimit }]),
      /rateLimit/,
      JSON.stringify(rateLimit),
    );
  }
});
