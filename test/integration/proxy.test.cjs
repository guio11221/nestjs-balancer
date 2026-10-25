'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { RouteBalancerService, RouteBalancerMiddleware } = require('../../dist/index.js');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.close(resolve);
  });
}

function createUpstream(id) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200).end('ok');
      return;
    }

    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id,
        path: req.url,
        body,
        method: req.method,
      }));
    });
  });

  return server;
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

test('round-robin, query strings and POST streaming', async (t) => {
  const upstreamA = createUpstream('one');
  const upstreamB = createUpstream('two');

  const urlA = await listen(upstreamA);
  const urlB = await listen(upstreamB);

  const { server, service } = createGateway({
    routes: [
      { path: '/api', upstreams: [urlA, urlB] },
    ],
  });

  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstreamA), close(upstreamB)]);
  });

  const res1 = await fetch(`${baseUrl}/api/users?x=1`);
  const res2 = await fetch(`${baseUrl}/api/users?x=2`);

  const json1 = await res1.json();
  const json2 = await res2.json();

  assert.deepEqual([json1.id, json2.id], ['one', 'two']);
  assert.equal(json1.path, '/api/users?x=1');

  const postRes = await fetch(`${baseUrl}/api/items`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'payload',
  });

  const postJson = await postRes.json();
  assert.equal(postJson.body, 'payload');
  assert.equal(postJson.method, 'POST');

  const active = service.metrics().routes[0].upstreams.reduce((sum, node) => sum + node.active, 0);
  assert.equal(active, 0);
});

test('circuit breaker excludes failed instance and retries GET', async (t) => {
  const healthy = createUpstream('healthy');
  const healthyUrl = await listen(healthy);

  const dead = http.createServer();
  const deadUrl = await listen(dead);
  await close(dead);

  const { server, service } = createGateway({
    routes: [
      {
        path: '/api',
        upstreams: [deadUrl, healthyUrl],
        retry: { attempts: 1 },
        circuitBreaker: { cooldownMs: 500 },
      },
    ],
  });

  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(healthy)]);
  });

  const response = await fetch(`${baseUrl}/api/test`);
  assert.equal(response.status, 200);

  const json = await response.json();
  assert.equal(json.id, 'healthy');
  assert.equal(service.metrics().routes[0].upstreams[0].healthy, false);
});

test('route prefix is preserved or stripped', async (t) => {
  const target = createUpstream('target');
  const targetUrl = await listen(target);

  const { server, service } = createGateway({
    routes: [
      { path: '/v1', upstreams: [targetUrl], stripPrefix: true },
    ],
  });

  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(target)]);
  });

  const stripped = await fetch(`${baseUrl}/v1/items?q=2`);
  const strippedJson = await stripped.json();
  assert.equal(strippedJson.path, '/items?q=2');

  const notFound = await fetch(`${baseUrl}/v123`);
  assert.equal(notFound.status, 404);
});
