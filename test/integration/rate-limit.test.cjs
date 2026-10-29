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

test('rate limits reject with 429 before contacting the upstream', async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    res.end('ok');
  });
  const upstreamUrl = await listen(upstream);

  const { server, service } = createGateway({
    routes: [{ path: '/api', upstreams: [upstreamUrl], rateLimit: { limit: 2, windowMs: 60_000 } }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  const first = await fetch(`${baseUrl}/api/x`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('ratelimit-limit'), '2');
  assert.equal(first.headers.get('ratelimit-remaining'), '1');
  assert.equal(first.headers.get('ratelimit-reset'), '30', 'half the capacity refills in half the window');

  const second = await fetch(`${baseUrl}/api/x`);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('ratelimit-remaining'), '0');

  const third = await fetch(`${baseUrl}/api/x`);
  assert.equal(third.status, 429);
  assert.equal(third.headers.get('retry-after'), '30');
  assert.equal(third.headers.get('cache-control'), 'no-store');
  const body = await third.text();
  assert.equal(JSON.parse(body).message, 'Rate limit exceeded');
  assert.equal(third.headers.get('content-length'), String(Buffer.byteLength(body)));

  assert.equal(upstreamRequests, 2);
  const metrics = service.metrics().routes[0];
  assert.equal(metrics.rateLimited, 1);
  assert.match(prometheusMetrics(service.metrics()), /route_balancer_route_rate_limited_total\{route="\/api"\} 1/);
});

test('a header key isolates consumers and falls back to the peer address', async (t) => {
  const upstream = http.createServer((req, res) => res.end('ok'));
  const upstreamUrl = await listen(upstream);

  const { server, service } = createGateway({
    routes: [{
      path: '/api',
      upstreams: [upstreamUrl],
      rateLimit: { limit: 1, windowMs: 60_000, key: 'header', header: 'x-api-key' },
    }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  assert.equal((await fetch(`${baseUrl}/api/x`, { headers: { 'x-api-key': 'one' } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/x`, { headers: { 'x-api-key': 'one' } })).status, 429);
  assert.equal((await fetch(`${baseUrl}/api/x`, { headers: { 'x-api-key': 'two' } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/x`)).status, 200, 'missing key falls back to the client address');
  assert.equal((await fetch(`${baseUrl}/api/x`)).status, 429);
});

test('rate limits are isolated per route and reset by a reload', async (t) => {
  const upstream = http.createServer((req, res) => res.end(req.url));
  const upstreamUrl = await listen(upstream);

  const { server, service } = createGateway({
    routes: [
      { path: '/a', upstreams: [upstreamUrl], rateLimit: { limit: 1, windowMs: 60_000 } },
      { path: '/b', upstreams: [upstreamUrl], rateLimit: { limit: 1, windowMs: 60_000 } },
    ],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  assert.equal((await fetch(`${baseUrl}/a/x`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/a/x`)).status, 429);
  assert.equal((await fetch(`${baseUrl}/b/x`)).status, 200);

  service.reloadRoutes({
    routes: [
      { path: '/a', upstreams: [upstreamUrl], rateLimit: { limit: 1, windowMs: 60_000 } },
      { path: '/b', upstreams: [upstreamUrl], rateLimit: { limit: 1, windowMs: 60_000 } },
    ],
  });
  assert.equal((await fetch(`${baseUrl}/a/x`)).status, 200, 'reload clears buckets for the new table');
});
