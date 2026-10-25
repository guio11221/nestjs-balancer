const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { RouteBalancerService, RouteBalancerMiddleware } = require('../../dist/index.js');

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { await new Promise(resolve => server.close(resolve)); }
function setup(options) {
  const service = new RouteBalancerService(options);
  const middleware = new RouteBalancerMiddleware(service);
  const gateway = http.createServer((req, res) => middleware.use(req, res, () => res.writeHead(404).end()));
  return { gateway, service };
}

test('removes hop-by-hop headers and untrusted forwarding metadata', async t => {
  const upstream = http.createServer((req, res) => {
    res.setHeader('connection', 'x-remove');
    res.setHeader('x-remove', 'hidden');
    res.setHeader('x-keep', 'visible');
    res.end(JSON.stringify({ forwarded: req.headers['x-forwarded-for'], spoof: req.headers.forwarded, private: req.headers['x-private'] }));
  });
  const url = await listen(upstream);
  const { gateway, service } = setup({ routes: [{ path: '/', upstreams: [url] }] });
  const base = await listen(gateway);
  t.after(async () => { service.onModuleDestroy(); await Promise.all([close(gateway), close(upstream)]); });
  const response = await fetch(base + '/users', {
    headers: { 'x-forwarded-for': '198.51.100.10', forwarded: 'for=198.51.100.10', 'x-private': 'sent' },
  });
  const result = await response.json();
  assert.equal(response.headers.get('x-remove'), null);
  assert.equal(response.headers.get('x-keep'), 'visible');
  assert.equal(result.spoof, undefined);
  assert.equal(result.private, 'sent');
  assert.ok(result.forwarded.includes('127.0.0.1'));
  assert.equal(result.forwarded.includes('198.51.100.10'), false);
});

test('fails over only before headers and does not replay POST', async t => {
  const failed = http.createServer((req, res) => req.socket.destroy());
  const working = http.createServer((req, res) => res.end('working'));
  const a = await listen(failed);
  const b = await listen(working);
  const { gateway, service } = setup({ routes: [{ path: '/', upstreams: [a, b], retry: { attempts: 1 } }] });
  const base = await listen(gateway);
  t.after(async () => { service.onModuleDestroy(); await Promise.all([close(gateway), close(failed), close(working)]); });
  assert.equal(await (await fetch(base + '/')).text(), 'working');
  // first server is open-circuited so use a new service to test POST against it.
  const other = setup({ routes: [{ path: '/', upstreams: [a, b], retry: { attempts: 1 } }] });
  const otherBase = await listen(other.gateway);
  t.after(async () => { other.service.onModuleDestroy(); await close(other.gateway); });
  assert.equal((await fetch(otherBase + '/', { method: 'POST', body: 'mutation' })).status, 502);
  assert.equal(other.service.metrics().routes[0].upstreams[1].requests, 0);
});

test('recovers via half-open request after cooldown', async t => {
  let ready = false;
  const upstream = http.createServer((req, res) => {
    if (!ready) req.socket.destroy();
    else res.end('recovered');
  });
  const url = await listen(upstream);
  const { gateway, service } = setup({ routes: [{ path: '/', upstreams: [url], circuitBreaker: { cooldownMs: 100, failureThreshold: 1 } }] });
  const base = await listen(gateway);
  t.after(async () => { service.onModuleDestroy(); await Promise.all([close(gateway), close(upstream)]); });
  assert.equal((await fetch(base + '/')).status, 502);
  assert.equal((await fetch(base + '/')).status, 503);
  await new Promise(resolve => setTimeout(resolve, 120));
  ready = true;
  assert.equal(await (await fetch(base + '/')).text(), 'recovered');
  assert.equal(service.metrics().routes[0].upstreams[0].healthy, true);
});

test('upstream prematurely closes response and circuit trips', async t => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10000' });
    res.write('partial');
    setImmediate(() => res.socket.destroy());
  });
  const url = await listen(upstream);
  const { gateway, service } = setup({ routes: [{ path: '/', upstreams: [url] }] });
  const base = await listen(gateway);
  t.after(async () => { service.onModuleDestroy(); await Promise.all([close(gateway), close(upstream)]); });
  await assert.rejects(fetch(base + '/').then(response => response.text()));
  assert.equal(service.metrics().routes[0].upstreams[0].healthy, false);
});

test('client cancellation does not trip the upstream circuit', async t => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('chunk');
    const timer = setInterval(() => res.write('.'), 20);
    res.once('close', () => clearInterval(timer));
  });
  const url = await listen(upstream);
  const { gateway, service } = setup({ routes: [{ path: '/', upstreams: [url], circuitBreaker: { failureThreshold: 1, cooldownMs: 100 } }] });
  const base = await listen(gateway);
  t.after(async () => { service.onModuleDestroy(); await Promise.all([close(gateway), close(upstream)]); });
  await new Promise((resolve, reject) => {
    const req = http.get(base + '/stream', res => {
      res.once('data', () => {
        req.destroy();
        resolve();
      });
    });
    req.once('error', error => {
      if (error.code === 'ECONNRESET') resolve();
      else reject(error);
    });
  });
  await new Promise(resolve => setTimeout(resolve, 50));
  const node = service.metrics().routes[0].upstreams[0];
  assert.equal(node.errors, 0);
  assert.equal(node.healthy, true);
  assert.equal(node.active, 0);
});

test('health probes use dedicated counters and recover an open circuit', async t => {
  let healthStatus = 500;
  const upstream = http.createServer((req, res) => {
    if (req.url === '/health') res.writeHead(healthStatus).end('health');
    else res.end('ok');
  });
  const url = await listen(upstream);
  const { service } = setup({ routes: [{ path: '/', upstreams: [url], healthCheck: { path: '/health', intervalMs: 1000, expectedStatus: [200] } }] });
  t.after(async () => { service.onModuleDestroy(); await close(upstream); });
  const route = service.routes[0];
  await service.checkRoute(route);
  let node = service.metrics().routes[0].upstreams[0];
  assert.equal(node.healthy, false);
  assert.equal(node.errors, 0);
  assert.equal(node.successes, 0);
  assert.equal(node.healthCheckFailures, 1);
  healthStatus = 200;
  await service.checkRoute(route);
  node = service.metrics().routes[0].upstreams[0];
  assert.equal(node.healthy, true);
  assert.equal(node.errors, 0);
  assert.equal(node.healthCheckSuccesses, 1);
});
