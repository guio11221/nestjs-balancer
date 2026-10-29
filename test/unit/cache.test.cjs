'use strict';

// Fluxo: cache local. Nenhum socket é aberto; o relógio é controlado quando necessário.

const test = require('node:test');
const assert = require('node:assert/strict');

const { RouteBalancerService } = require('../../dist/index.js');

const A = 'http://127.0.0.1:3001';

function createService(routes) {
  return new RouteBalancerService({ routes });
}

function store(service, route, key, body, ttlMs = 60_000) {
  service.storeCache(
    route,
    { key, pathname: '/api/x', head: false },
    { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(body), ttlMs },
  );
}

test('cache keys include method, URL, accept-encoding and configured vary headers', () => {
  const service = createService([{ path: '/api', upstreams: [A], cache: { ttlMs: 60_000, vary: ['Accept-Language'] } }]);
  const route = service.findRoute('/api');

  const plain = service.cacheContextFor(route, 'GET', '/api/x', '?a=1', { 'accept-language': 'pt' });
  const same = service.cacheContextFor(route, 'GET', '/api/x', '?a=1', { 'accept-language': 'pt' });
  const otherLanguage = service.cacheContextFor(route, 'GET', '/api/x', '?a=1', { 'accept-language': 'en' });
  const otherMethod = service.cacheContextFor(route, 'HEAD', '/api/x', '?a=1', { 'accept-language': 'pt' });
  const otherQuery = service.cacheContextFor(route, 'GET', '/api/x', '?a=2', { 'accept-language': 'pt' });
  const otherEncoding = service.cacheContextFor(route, 'GET', '/api/x', '?a=1', { 'accept-language': 'pt', 'accept-encoding': 'br' });

  assert.deepEqual(plain.vary, ['accept-encoding', 'accept-language']);
  assert.equal(plain.key, same.key);
  assert.notEqual(plain.key, otherLanguage.key);
  assert.notEqual(plain.key, otherMethod.key);
  assert.notEqual(plain.key, otherQuery.key);
  assert.notEqual(plain.key, otherEncoding.key);

  service.onModuleDestroy();
});

test('cache hits, misses and expiry counters behave deterministically', () => {
  const realNow = Date.now;
  let now = 100_000;
  Date.now = () => now;
  const service = createService([{ path: '/api', upstreams: [A], cache: { ttlMs: 1000 } }]);
  const route = service.findRoute('/api');

  try {
    assert.equal(service.getCached(route, 'missing'), undefined);
    assert.equal(route.cacheMisses, 1);

    store(service, route, 'key', 'body', 1000);
    assert.equal(service.getCached(route, 'key').body.toString(), 'body');
    assert.equal(route.cacheHits, 1);
    assert.equal(route.cacheStores, 1);

    now += 1001;
    assert.equal(service.getCached(route, 'key'), undefined, 'expired entries are dropped on read');
    assert.equal(route.cacheMisses, 2);
  } finally {
    Date.now = realNow;
    service.onModuleDestroy();
  }
});

test('entry and byte budgets evict the least recently used variant', () => {
  const service = createService([{
    path: '/api',
    upstreams: [A],
    cache: { ttlMs: 60_000, maxEntries: 2, maxBytes: 100 },
  }]);
  const route = service.findRoute('/api');

  store(service, route, 'a', 'aaa');
  store(service, route, 'b', 'bbb');
  assert.ok(service.getCached(route, 'a'), 'touch a so b becomes the oldest');
  store(service, route, 'c', 'ccc');

  assert.ok(service.getCached(route, 'a'));
  assert.equal(service.getCached(route, 'b'), undefined, 'oldest variant is evicted');
  assert.ok(service.getCached(route, 'c'));

  service.clearCache();
  assert.equal(service.getCached(route, 'a'), undefined);

  service.onModuleDestroy();
});

test('responses larger than maxEntryBytes are never stored', () => {
  const service = createService([{ path: '/api', upstreams: [A], cache: { ttlMs: 60_000, maxEntryBytes: 4 } }]);
  const route = service.findRoute('/api');

  store(service, route, 'small', 'good');
  store(service, route, 'large', 'too-large');

  assert.ok(service.getCached(route, 'small'));
  assert.equal(service.getCached(route, 'large'), undefined);
  assert.equal(route.cacheStores, 1);

  service.onModuleDestroy();
});

test('invalidation is scoped by pathname and route', () => {
  const service = createService([
    { path: '/api', upstreams: [A], cache: { ttlMs: 60_000 } },
    { path: '/v2', upstreams: [A], cache: { ttlMs: 60_000 } },
  ]);
  const api = service.findRoute('/api');
  const v2 = service.findRoute('/v2');

  store(service, api, 'a1', 'one');
  store(service, api, 'a2', 'two');
  store(service, v2, 'v1', 'three');

  service.invalidateCache(api, '/api/x');

  assert.equal(service.getCached(api, 'a1'), undefined);
  assert.equal(service.getCached(api, 'a2'), undefined);
  assert.ok(service.getCached(v2, 'v1'), 'other routes keep their entries');

  service.clearCache('/v2');
  assert.equal(service.getCached(v2, 'v1'), undefined);

  service.onModuleDestroy();
});

test('reloads prevent in-flight snapshots from repopulating the cache', () => {
  const service = createService([{ path: '/api', upstreams: [A], cache: { ttlMs: 60_000 } }]);
  const previous = service.findRoute('/api');

  service.reloadRoutes({ routes: [{ path: '/api', upstreams: [A], cache: { ttlMs: 60_000 } }] });
  store(service, previous, 'stale', 'old snapshot');

  assert.equal(service.getCached(service.findRoute('/api'), 'stale'), undefined);
  service.onModuleDestroy();
});

test('single-flight coordination resolves waiters', async () => {
  const service = createService([{ path: '/api', upstreams: [A] }]);

  assert.equal(service.beginCacheFill('key'), true);
  assert.equal(service.beginCacheFill('key'), false, 'only one leader per key');

  const waiter = service.awaitCacheFill('key', 1000);
  service.endCacheFill('key');
  await waiter;

  assert.equal(service.beginCacheFill('key'), true, 'the key is reusable after completion');
  service.endCacheFill('key');

  service.onModuleDestroy();
});

test('cache configuration is validated', () => {
  const cases = [
    { ttlMs: 0 },
    { ttlMs: -1 },
    { ttlMs: 1000, statuses: [] },
    { ttlMs: 1000, statuses: [99] },
    { ttlMs: 1000, vary: ['*'] },
    { ttlMs: 1000, vary: ['bad header'] },
    { ttlMs: 1000, maxEntries: 0 },
    { ttlMs: 1000, maxBytes: 0 },
    { ttlMs: 1000, maxEntryBytes: 0 },
  ];
  for (const cache of cases) {
    assert.throws(
      () => createService([{ path: '/api', upstreams: [A], cache }]),
      /cache/,
      JSON.stringify(cache),
    );
  }
});
