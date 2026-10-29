'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

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

function rawRequest(port, payload) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('error', () => resolve(data));
    socket.on('close', () => resolve(data));
  });
}

function parseRawResponse(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const [statusLine, ...lines] = head.split('\r\n');
  const headers = {};
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { statusLine, headers, body: rest.join('\r\n\r\n') };
}

function getSetCookies(response) {
  const values = response.headers.getSetCookie?.();
  if (values && values.length > 0) return values;
  const single = response.headers.get('set-cookie');
  return single ? [single] : [];
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

test('sticky sessions use opaque signed tokens and reject tampering', async (t) => {
  const upstreamA = createUpstream('one');
  const upstreamB = createUpstream('two');
  const urlA = await listen(upstreamA);
  const urlB = await listen(upstreamB);

  const { server, service } = createGateway({
    routes: [{
      path: '/api',
      upstreams: [urlA, urlB],
      sticky: { cookie: 'lb', ttlMs: 60000, secret: 'test-secret', sameSite: 'strict' },
    }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstreamA), close(upstreamB)]);
  });

  const first = await fetch(`${baseUrl}/api/sticky`);
  assert.equal((await first.json()).id, 'one');
  const cookies = getSetCookies(first);
  assert.equal(cookies.length, 1);
  assert.match(cookies[0], /HttpOnly/);
  assert.match(cookies[0], /SameSite=Strict/);
  assert.equal(cookies[0].includes('127.0.0.1'), false);
  const pair = cookies[0].split(';')[0];

  const second = await fetch(`${baseUrl}/api/sticky`, { headers: { cookie: pair } });
  assert.equal((await second.json()).id, 'one');

  const tampered = await fetch(`${baseUrl}/api/sticky`, { headers: { cookie: 'lb=deadbeef' } });
  assert.equal((await tampered.json()).id, 'two');

  const empty = await fetch(`${baseUrl}/api/sticky`, { headers: { cookie: 'lb=' } });
  assert.equal((await empty.json()).id, 'one');
});

test('sticky cookies are appended to upstream Set-Cookie headers', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.setHeader('set-cookie', ['upstream=a; Path=/', 'upstream=b; Path=/']);
    res.end('ok');
  });
  const url = await listen(upstream);

  const { server, service } = createGateway({
    routes: [{
      path: '/api',
      upstreams: [url],
      sticky: { cookie: 'lb', ttlMs: 60000, secret: 'test-secret' },
    }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  const response = await fetch(`${baseUrl}/api/cookies`);
  assert.equal(await response.text(), 'ok');
  const cookies = getSetCookies(response);
  assert.equal(cookies.length, 3);
  assert.ok(cookies.some(value => value.startsWith('upstream=a')));
  assert.ok(cookies.some(value => value.startsWith('upstream=b')));
  assert.ok(cookies.some(value => value.startsWith('lb=')));
});

test('client request ids are validated before being echoed or forwarded', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers['x-request-id']);
    res.end('ok');
  });
  const upstreamUrl = await listen(upstream);
  const { server, service } = createGateway({ routes: [{ path: '/api', upstreams: [upstreamUrl] }] });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  const valid = await fetch(`${baseUrl}/api/one`, { headers: { 'x-request-id': 'req-abc_123' } });
  assert.equal(valid.headers.get('x-request-id'), 'req-abc_123');

  const withSpace = await fetch(`${baseUrl}/api/two`, { headers: { 'x-request-id': 'bad id' } });
  const withSpaceId = withSpace.headers.get('x-request-id');
  assert.match(withSpaceId, /^[0-9a-f]{32}$/);

  const oversized = await fetch(`${baseUrl}/api/three`, { headers: { 'x-request-id': 'x'.repeat(2048) } });
  const oversizedId = oversized.headers.get('x-request-id');
  assert.match(oversizedId, /^[0-9a-f]{32}$/);

  assert.deepEqual(seen, ['req-abc_123', withSpaceId, oversizedId]);
});

test('HTTP/1.0 requests without Host do not emit empty forwarded headers', async (t) => {
  let seenHeaders;
  const upstream = http.createServer((req, res) => {
    seenHeaders = req.headers;
    res.end('ok');
  });
  const upstreamUrl = await listen(upstream);
  const { server, service } = createGateway({ routes: [{ path: '/api', upstreams: [upstreamUrl] }] });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  const raw = await rawRequest(new URL(baseUrl).port, 'GET /api/legacy HTTP/1.0\r\n\r\n');
  const parsed = parseRawResponse(raw);
  assert.match(parsed.statusLine, /^HTTP\/1\.1 200/);

  assert.equal(seenHeaders['x-forwarded-host'], undefined);
  assert.equal(seenHeaders['x-forwarded-for'], '127.0.0.1');
  assert.equal(seenHeaders['x-forwarded-proto'], 'http');
  assert.equal(seenHeaders.forwarded, undefined);
});

test('synthetic error responses are framed, non-cacheable and close on shutdown', async (t) => {
  const { server, service } = createGateway({
    routes: [{ path: '/api', upstreams: ['http://127.0.0.1:1'], retry: { attempts: 0 } }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await close(server);
  });

  const port = new URL(baseUrl).port;
  const badGateway = parseRawResponse(await rawRequest(port, 'GET /api/x HTTP/1.1\r\nHost: test\r\nConnection: close\r\n\r\n'));
  assert.match(badGateway.statusLine, /^HTTP\/1\.1 502/);
  assert.equal(badGateway.headers['cache-control'], 'no-store');
  assert.equal(Number(badGateway.headers['content-length']), Buffer.byteLength(badGateway.body));
  assert.equal(JSON.parse(badGateway.body).statusCode, 502);

  await service.onModuleDestroy();
  const unavailable = parseRawResponse(await rawRequest(port, 'GET /api/x HTTP/1.1\r\nHost: test\r\n\r\n'));
  assert.match(unavailable.statusLine, /^HTTP\/1\.1 503/);
  assert.equal(unavailable.headers.connection, 'close');
  assert.equal(Number(unavailable.headers['content-length']), Buffer.byteLength(unavailable.body));
  assert.equal(JSON.parse(unavailable.body).message, 'Server shutting down');
});

test('latency metrics measure the successful attempt, not retries and backoff', async (t) => {
  const slow = http.createServer((req) => {
    setTimeout(() => { req.socket.destroy(); }, 150);
  });
  const fast = http.createServer((req, res) => res.end('ok'));
  const slowUrl = await listen(slow);
  const fastUrl = await listen(fast);

  const { server, service } = createGateway({
    routes: [{
      path: '/api',
      upstreams: [slowUrl, fastUrl],
      retry: { attempts: 1, methods: ['GET'], backoffMs: 0, retryOn: ['network'] },
    }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(slow), close(fast)]);
  });

  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/api/slow`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'ok');
  assert.ok(Date.now() - startedAt >= 140, 'the failed attempt should dominate the total duration');

  const [slowNode, fastNode] = service.metrics().routes[0].upstreams;
  assert.equal(slowNode.errors, 1);
  assert.equal(slowNode.ewmaResponseTimeMs, 0);
  assert.equal(fastNode.successes, 1);
  assert.ok(fastNode.ewmaResponseTimeMs > 0 && fastNode.ewmaResponseTimeMs < 120,
    `expected the successful attempt latency, received ${fastNode.ewmaResponseTimeMs}ms`);
  assert.ok(fastNode.ewmaObservedAt > 0);
});

test('HEAD and 204 responses are forwarded without a body', async (t) => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/api/head') {
      res.writeHead(200, { 'content-length': '5' }).end('hello');
      return;
    }
    res.writeHead(204).end();
  });
  const upstreamUrl = await listen(upstream);
  const { server, service } = createGateway({ routes: [{ path: '/api', upstreams: [upstreamUrl] }] });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  const head = await fetch(`${baseUrl}/api/head`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '5');
  assert.equal(await head.text(), '');

  const empty = await fetch(`${baseUrl}/api/empty`);
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), '');
});

test('changeOrigin rewrites Host while disabled keeps the gateway authority', async (t) => {
  const hosts = [];
  const upstream = http.createServer((req, res) => {
    hosts.push(req.headers.host);
    res.end('ok');
  });
  const upstreamUrl = await listen(upstream);
  const { server, service } = createGateway({
    routes: [
      { path: '/keep', upstreams: [upstreamUrl], changeOrigin: false },
      { path: '/change', upstreams: [upstreamUrl] },
    ],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  await (await fetch(`${baseUrl}/keep/x`)).text();
  await (await fetch(`${baseUrl}/change/x`)).text();

  assert.equal(hosts[0], new URL(baseUrl).host);
  assert.equal(hosts[1], new URL(upstreamUrl).host);
});

test('stripPrefix handles the exact boundary and preserves encoded queries', async (t) => {
  const paths = [];
  const upstream = http.createServer((req, res) => {
    paths.push(req.url);
    res.end('ok');
  });
  const upstreamUrl = await listen(upstream);
  const { server, service } = createGateway({
    routes: [{ path: '/v1', upstreams: [upstreamUrl], stripPrefix: true }],
  });
  const baseUrl = await listen(server);

  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(server), close(upstream)]);
  });

  await (await fetch(`${baseUrl}/v1`)).text();
  await (await fetch(`${baseUrl}/v1/a%2Fb?x=%2F&y=+`)).text();

  assert.deepEqual(paths, ['/', '/a%2Fb?x=%2F&y=+']);
});
