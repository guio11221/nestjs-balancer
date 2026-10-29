'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { RouteBalancerService, RouteBalancerMiddleware } = require('../../dist/index.js');

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

function createEcho(id) {
  return http.createServer((req, res) => res.end(id));
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

test('draining an upstream stops new traffic and resume restores it', async (t) => {
  const upstreamA = createEcho('a');
  const upstreamB = createEcho('b');
  const urlA = await listen(upstreamA);
  const urlB = await listen(upstreamB);

  const { server, service } = createGateway({ routes: [{ path: '/api', upstreams: [urlA, urlB] }] });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstreamA), close(upstreamB)]);
  });

  const get = async () => (await fetch(`${baseUrl}/api/x`)).text();

  assert.equal(await get(), 'a');
  assert.equal(service.drainUpstream('/api', urlA), true);
  for (let index = 0; index < 4; index += 1) assert.equal(await get(), 'b');

  assert.equal(service.resumeUpstream('/api', urlA), true);
  const resumed = [await get(), await get(), await get(), await get()];
  assert.ok(resumed.includes('a'), `expected traffic to return to the resumed upstream: ${resumed}`);
  assert.ok(resumed.includes('b'), `expected both upstreams to serve traffic: ${resumed}`);
  assert.equal(service.metrics().routes[0].upstreams[0].drained, false);
});

test('draining every upstream returns 503 until one is resumed', async (t) => {
  const upstream = createEcho('only');
  const upstreamUrl = await listen(upstream);
  const { server, service } = createGateway({ routes: [{ path: '/api', upstreams: [upstreamUrl] }] });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  service.drainUpstream('/api', upstreamUrl);
  const drained = await fetch(`${baseUrl}/api/x`);
  assert.equal(drained.status, 503);
  const body = await drained.text();
  assert.equal(JSON.parse(body).message, 'No healthy upstream available');
  assert.equal(drained.headers.get('content-length'), String(Buffer.byteLength(body)));

  service.resumeUpstream('/api', upstreamUrl);
  const resumed = await fetch(`${baseUrl}/api/x`);
  assert.equal(resumed.status, 200);
  assert.equal(await resumed.text(), 'only');
});

test('runtime weight changes drive weighted round robin', async (t) => {
  const upstreamA = createEcho('a');
  const upstreamB = createEcho('b');
  const urlA = await listen(upstreamA);
  const urlB = await listen(upstreamB);

  const { server, service } = createGateway({
    routes: [{ path: '/api', upstreams: [urlA, urlB], strategy: 'weighted-round-robin' }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstreamA), close(upstreamB)]);
  });

  assert.equal(service.setUpstreamWeight('/api', urlA, 5), true);
  assert.equal(service.setUpstreamWeight('/api', urlB, 1), true);

  const counts = { a: 0, b: 0 };
  for (let index = 0; index < 12; index += 1) {
    counts[await (await fetch(`${baseUrl}/api/x`)).text()] += 1;
  }
  assert.deepEqual(counts, { a: 10, b: 2 });
});

test('reloading routes adds and removes routes while carrying counters', async (t) => {
  const upstreamA = createEcho('a');
  const upstreamB = createEcho('b');
  const urlA = await listen(upstreamA);
  const urlB = await listen(upstreamB);

  const { server, service } = createGateway({ routes: [{ path: '/api', upstreams: [urlA] }] });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstreamA), close(upstreamB)]);
  });

  await (await fetch(`${baseUrl}/api/one`)).text();
  await (await fetch(`${baseUrl}/api/two`)).text();
  assert.equal(service.metrics().routes[0].upstreams[0].requests, 2);

  const added = service.reloadRoutes({
    routes: [
      { path: '/api', upstreams: [urlA] },
      { path: '/extra', upstreams: [urlB] },
    ],
  });
  assert.deepEqual(added, { added: ['/extra'], removed: [], updated: [] });
  assert.equal(service.metrics().routes.length, 2);
  const apiMetrics = service.metrics().routes.find((route) => route.path === '/api');
  assert.equal(apiMetrics.upstreams[0].requests, 2);
  assert.equal(await (await fetch(`${baseUrl}/extra/x`)).text(), 'b');
  assert.equal(await (await fetch(`${baseUrl}/api/x`)).text(), 'a');

  const removed = service.reloadRoutes({ routes: [] });
  assert.deepEqual(removed, { added: [], removed: ['/extra', '/api'], updated: [] });
  const notFound = await fetch(`${baseUrl}/api/x`);
  assert.equal(notFound.status, 404);
  assert.equal(service.metrics().routes.length, 0);
});

test('in-flight requests finish on the previous snapshot during a reload', async (t) => {
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const slow = http.createServer((req, res) => {
    markStarted();
    setTimeout(() => res.end('slow'), 120);
  });
  const fast = createEcho('fast');
  const slowUrl = await listen(slow);
  const fastUrl = await listen(fast);

  const { server, service } = createGateway({ routes: [{ path: '/api', upstreams: [slowUrl] }] });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(slow), close(fast)]);
  });

  const pending = fetch(`${baseUrl}/api/inflight`);
  await started;

  service.reloadRoutes({
    routes: [
      { path: '/api', upstreams: [slowUrl] },
      { path: '/extra', upstreams: [fastUrl] },
    ],
  });

  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'slow');

  const api = service.metrics().routes.find((route) => route.path === '/api');
  assert.equal(api.upstreams[0].active, 0);
  assert.equal(await (await fetch(`${baseUrl}/extra/x`)).text(), 'fast');
});
