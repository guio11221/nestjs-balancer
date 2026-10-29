'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { RouteBalancerService, RouteBalancerMiddleware, prometheusMetrics } = require('../../dist/index.js');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
  });
}

function createGateway(options) {
  const service = new RouteBalancerService(options);
  const middleware = new RouteBalancerMiddleware(service);
  const server = http.createServer((req, res) => {
    middleware.use(req, res, () => {
      res.writeHead(404).end('not found');
    });
  });
  return { server, service };
}

test('GET responses are cached and served with x-cache and Age', async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    res.setHeader('content-type', 'text/plain');
    res.end(`body-${upstreamHits}`);
  });
  const upstreamUrl = await listen(upstream);

  const { server, service } = createGateway({
    routes: [{ path: '/api', upstreams: [upstreamUrl], cache: { ttlMs: 60_000 } }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  const first = await fetch(`${baseUrl}/api/x`);
  assert.equal(await first.text(), 'body-1');
  assert.equal(first.headers.get('x-cache'), 'MISS');

  const second = await fetch(`${baseUrl}/api/x`);
  assert.equal(await second.text(), 'body-1');
  assert.equal(second.headers.get('x-cache'), 'HIT');
  assert.equal(second.headers.get('age'), '0');
  assert.equal(second.headers.get('x-request-id')?.length > 0, true);

  assert.equal(upstreamHits, 1);
  const metrics = service.metrics().routes[0];
  assert.equal(metrics.cacheHits, 1);
  assert.equal(metrics.cacheMisses, 1);
  assert.equal(metrics.cacheStores, 1);
  const exposition = prometheusMetrics(service.metrics());
  assert.match(exposition, /route_balancer_route_cache_hits_total\{route="\/api"\} 1/);
  assert.match(exposition, /route_balancer_route_cache_stores_total\{route="\/api"\} 1/);
});

test('configured Vary headers produce separate variants', async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    res.setHeader('vary', 'accept-language');
    res.end(`${req.headers['accept-language']}-${upstreamHits}`);
  });
  const upstreamUrl = await listen(upstream);

  const { server, service } = createGateway({
    routes: [{
      path: '/api',
      upstreams: [upstreamUrl],
      cache: { ttlMs: 60_000, vary: ['accept-language'] },
    }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  const pt = await (await fetch(`${baseUrl}/api/x`, { headers: { 'accept-language': 'pt' } })).text();
  const ptAgain = await (await fetch(`${baseUrl}/api/x`, { headers: { 'accept-language': 'pt' } })).text();
  const en = await (await fetch(`${baseUrl}/api/x`, { headers: { 'accept-language': 'en' } })).text();

  assert.equal(pt, 'pt-1');
  assert.equal(ptAgain, 'pt-1');
  assert.equal(en, 'en-2');
  assert.equal(upstreamHits, 2);
});

test('uncacheable responses bypass the cache', async (t) => {
  const hits = new Map();
  const upstream = http.createServer((req, res) => {
    hits.set(req.url, (hits.get(req.url) ?? 0) + 1);
    if (req.url === '/api/nostore') res.setHeader('cache-control', 'no-store');
    if (req.url === '/api/private') res.setHeader('cache-control', 'private, max-age=60');
    if (req.url === '/api/nocache') res.setHeader('cache-control', 'no-cache');
    if (req.url === '/api/zero') res.setHeader('cache-control', 'max-age=0');
    if (req.url === '/api/cookie') res.setHeader('set-cookie', 'session=1; Path=/');
    if (req.url === '/api/star') res.setHeader('vary', '*');
    if (req.url === '/api/error') {
      res.statusCode = 500;
    }
    res.end('payload');
  });
  const upstreamUrl = await listen(upstream);

  const { server, service } = createGateway({
    routes: [{ path: '/api', upstreams: [upstreamUrl], cache: { ttlMs: 60_000 } }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  for (const path of ['nostore', 'private', 'nocache', 'zero', 'cookie', 'star', 'error']) {
    const first = await fetch(`${baseUrl}/api/${path}`);
    assert.equal(first.headers.get('x-cache'), 'BYPASS', path);
    await first.text();
    const second = await fetch(`${baseUrl}/api/${path}`);
    assert.equal(second.headers.get('x-cache'), 'BYPASS', path);
    await second.text();
    assert.equal(hits.get(`/api/${path}`), 2, path);
  }
});

test('unsafe methods invalidate cached variants for the same pathname', async (t) => {
  let gets = 0;
  const upstream = http.createServer((req, res) => {
    if (req.method === 'GET') gets += 1;
    res.end(req.method === 'GET' ? `get-${gets}` : 'written');
  });
  const upstreamUrl = await listen(upstream);

  const { server, service } = createGateway({
    routes: [{ path: '/api', upstreams: [upstreamUrl], cache: { ttlMs: 60_000 } }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  assert.equal(await (await fetch(`${baseUrl}/api/items`)).text(), 'get-1');
  const cached = await fetch(`${baseUrl}/api/items`);
  assert.equal(cached.headers.get('x-cache'), 'HIT');

  assert.equal(await (await fetch(`${baseUrl}/api/items`, { method: 'POST', body: 'x' })).text(), 'written');
  const afterWrite = await fetch(`${baseUrl}/api/items`);
  assert.equal(afterWrite.headers.get('x-cache'), 'MISS');
  assert.equal(await afterWrite.text(), 'get-2');
});

test('authorization, cookie, Range and client no-cache bypass the cache', async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    res.end('payload');
  });
  const upstreamUrl = await listen(upstream);

  const { server, service } = createGateway({
    routes: [{ path: '/api', upstreams: [upstreamUrl], cache: { ttlMs: 60_000 } }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  const auth = await fetch(`${baseUrl}/api/x`, { headers: { authorization: 'Bearer token' } });
  assert.equal(auth.headers.get('x-cache'), null);
  const cookie = await fetch(`${baseUrl}/api/x`, { headers: { cookie: 'session=1' } });
  assert.equal(cookie.headers.get('x-cache'), null);
  const range = await fetch(`${baseUrl}/api/x`, { headers: { range: 'bytes=0-2' } });
  assert.equal(range.headers.get('x-cache'), null);
  const noCache = await fetch(`${baseUrl}/api/x`, { headers: { 'cache-control': 'no-cache' } });
  assert.equal(noCache.headers.get('x-cache'), null);

  assert.equal(upstreamHits, 4);
});

test('cached entries expire after the configured TTL', async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    res.end(`hit-${upstreamHits}`);
  });
  const upstreamUrl = await listen(upstream);

  const { server, service } = createGateway({
    routes: [{ path: '/api', upstreams: [upstreamUrl], cache: { ttlMs: 40 } }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  assert.equal(await (await fetch(`${baseUrl}/api/x`)).text(), 'hit-1');
  assert.equal(await (await fetch(`${baseUrl}/api/x`)).text(), 'hit-1');
  await new Promise(resolve => setTimeout(resolve, 70));
  const expired = await fetch(`${baseUrl}/api/x`);
  assert.equal(expired.headers.get('x-cache'), 'MISS');
  assert.equal(await expired.text(), 'hit-2');
});

test('concurrent misses are coalesced into one upstream request', async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    setTimeout(() => res.end('slow-body'), 80);
  });
  const upstreamUrl = await listen(upstream);

  const { server, service } = createGateway({
    routes: [{ path: '/api', upstreams: [upstreamUrl], cache: { ttlMs: 60_000 } }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  const bodies = await Promise.all(Array.from({ length: 5 }, async () => {
    const response = await fetch(`${baseUrl}/api/slow`);
    return response.text();
  }));

  assert.deepEqual(bodies, Array(5).fill('slow-body'));
  assert.equal(upstreamHits, 1, 'followers wait for the leader instead of hitting the upstream');

  const after = await fetch(`${baseUrl}/api/slow`);
  assert.equal(after.headers.get('x-cache'), 'HIT');
  assert.equal(upstreamHits, 1);
});

test('aborting a request queued behind a cache fill releases its lifecycle', async (t) => {
  let release;
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    release = () => res.end('leader-body');
  });
  const upstreamUrl = await listen(upstream);

  const { server, service } = createGateway({
    routes: [{ path: '/api', upstreams: [upstreamUrl], cache: { ttlMs: 60_000 } }],
    shutdownTimeoutMs: 200,
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    if (release) release();
    service.onModuleDestroy();
    server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([close(server), close(upstream)]);
  });

  const leader = fetch(`${baseUrl}/api/coalesce`);
  const started = Date.now();
  while (!release && Date.now() - started < 1000) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(release, 'the leader should reach the upstream');

  const controller = new AbortController();
  const follower = fetch(`${baseUrl}/api/coalesce`, { signal: controller.signal }).catch(error => error);
  const queued = Date.now();
  while (service.inFlight.size < 2 && Date.now() - queued < 1000) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.inFlight.size, 2, 'the follower should be waiting on the cache fill');

  controller.abort();
  const released = Date.now();
  while (service.inFlight.size > 1 && Date.now() - released < 1000) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(service.inFlight.size, 1, 'an aborted follower must not stay tracked until the leader finishes');

  release();
  release = undefined;
  assert.equal(await (await leader).text(), 'leader-body');
  assert.ok((await follower) instanceof Error);
  assert.equal(upstreamHits, 1);
});

test('responses above maxEntryBytes stream through without being cached', async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    res.end('0123456789');
  });
  const upstreamUrl = await listen(upstream);

  const { server, service } = createGateway({
    routes: [{ path: '/api', upstreams: [upstreamUrl], cache: { ttlMs: 60_000, maxEntryBytes: 4 } }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  assert.equal(await (await fetch(`${baseUrl}/api/x`)).text(), '0123456789');
  const second = await fetch(`${baseUrl}/api/x`);
  assert.equal(second.headers.get('x-cache'), 'MISS');
  assert.equal(await second.text(), '0123456789');
  assert.equal(upstreamHits, 2);
  assert.equal(service.metrics().routes[0].cacheStores, 0);
});

test('HEAD responses are cached separately without a body', async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-length': '5' }).end('hello');
  });
  const upstreamUrl = await listen(upstream);

  const { server, service } = createGateway({
    routes: [{ path: '/api', upstreams: [upstreamUrl], cache: { ttlMs: 60_000 } }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  const first = await fetch(`${baseUrl}/api/head`, { method: 'HEAD' });
  assert.equal(first.headers.get('content-length'), '5');
  assert.equal(first.headers.get('x-cache'), 'MISS');
  assert.equal(await first.text(), '');

  const second = await fetch(`${baseUrl}/api/head`, { method: 'HEAD' });
  assert.equal(second.headers.get('x-cache'), 'HIT');
  assert.equal(second.headers.get('content-length'), '5');
  assert.equal(await second.text(), '');
  assert.equal(upstreamHits, 1);
});
