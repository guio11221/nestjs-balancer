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

test('headers timeout fails fast and records a transport failure', async t => {
  const upstream = http.createServer(() => {});
  const url = await listen(upstream);
  const { gateway, service } = setup({
    routes: [{ path: '/', upstreams: [url], timeouts: { headersTimeoutMs: 60, requestTimeoutMs: 2000, connectTimeoutMs: 1000, idleTimeoutMs: 1000 } }],
  });
  const base = await listen(gateway);
  t.after(async () => {
    service.onModuleDestroy();
    upstream.closeAllConnections();
    await Promise.all([close(gateway), close(upstream)]);
  });

  const started = Date.now();
  const response = await fetch(base + '/');
  assert.equal(response.status, 502);
  assert.ok(Date.now() - started < 1000);
  assert.equal(service.metrics().routes[0].upstreams[0].errors, 1);
});

test('idle timeout terminates a stalled response stream after headers', async t => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('start');
  });
  const url = await listen(upstream);
  const { gateway, service } = setup({
    routes: [{ path: '/', upstreams: [url], timeouts: { headersTimeoutMs: 1000, requestTimeoutMs: 5000, idleTimeoutMs: 60 } }],
  });
  const base = await listen(gateway);
  t.after(async () => {
    service.onModuleDestroy();
    upstream.closeAllConnections();
    await Promise.all([close(gateway), close(upstream)]);
  });

  const response = await fetch(base + '/');
  const started = Date.now();
  await assert.rejects(async () => response.text());
  assert.ok(Date.now() - started < 1000);
  assert.equal(service.metrics().routes[0].upstreams[0].errors, 1);
});

test('request timeout covers the whole response, not only headers', async t => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const timer = setInterval(() => res.write('.'), 20);
    res.once('close', () => clearInterval(timer));
  });
  const url = await listen(upstream);
  const { gateway, service } = setup({
    routes: [{ path: '/', upstreams: [url], timeouts: { headersTimeoutMs: 1000, requestTimeoutMs: 100, idleTimeoutMs: 5000 } }],
  });
  const base = await listen(gateway);
  t.after(async () => {
    service.onModuleDestroy();
    upstream.closeAllConnections();
    await Promise.all([close(gateway), close(upstream)]);
  });

  const response = await fetch(base + '/');
  const started = Date.now();
  await assert.rejects(async () => response.text());
  assert.ok(Date.now() - started < 1000);
});

test('retryOn policy prevents retrying non-matching failures', async t => {
  const failed = http.createServer((req, res) => req.socket.destroy());
  const working = http.createServer((req, res) => res.end('working'));
  const a = await listen(failed);
  const b = await listen(working);
  const { gateway, service } = setup({
    routes: [{ path: '/', upstreams: [a, b], retry: { attempts: 1, retryOn: ['timeout'] } }],
  });
  const base = await listen(gateway);
  t.after(async () => {
    service.onModuleDestroy();
    failed.closeAllConnections();
    await Promise.all([close(gateway), close(failed), close(working)]);
  });

  const response = await fetch(base + '/');
  assert.equal(response.status, 502);
  assert.equal(service.metrics().routes[0].upstreams[1].requests, 0);
});

test('maxRetryRate zero disables failover retries', async t => {
  const failed = http.createServer((req, res) => req.socket.destroy());
  const working = http.createServer((req, res) => res.end('working'));
  const a = await listen(failed);
  const b = await listen(working);
  const { gateway, service } = setup({
    routes: [{ path: '/', upstreams: [a, b], retry: { attempts: 1, maxRetryRate: 0 } }],
  });
  const base = await listen(gateway);
  t.after(async () => {
    service.onModuleDestroy();
    failed.closeAllConnections();
    await Promise.all([close(gateway), close(failed), close(working)]);
  });

  const response = await fetch(base + '/');
  assert.equal(response.status, 502);
  assert.equal(service.metrics().routes[0].upstreams[1].requests, 0);
});

test('allowedHosts rejects mismatched downstream hosts', async t => {
  const upstream = http.createServer((req, res) => res.end('ok'));
  const url = await listen(upstream);
  const { gateway, service } = setup({
    routes: [{ path: '/', upstreams: [url], allowedHosts: ['example.com', '*.internal.test'] }],
  });
  const base = await listen(gateway);
  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(gateway), close(upstream)]);
  });

  const target = new URL(base);
  const request = host => new Promise((resolve, reject) => {
    const req = http.request({ host: target.hostname, port: target.port, path: '/', headers: { host } }, res => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
    req.once('error', reject);
    req.end();
  });

  assert.equal(await request('evil.example'), 421);
  assert.equal(await request('example.com'), 200);
  assert.equal(await request('app.internal.test'), 200);
});

test('shutdown aborts in-flight requests and resolves', async t => {
  const upstream = http.createServer(() => {});
  const url = await listen(upstream);
  const { gateway, service } = setup({ routes: [{ path: '/', upstreams: [url] }], shutdownTimeoutMs: 200 });
  const base = await listen(gateway);
  t.after(async () => {
    upstream.closeAllConnections();
    gateway.closeAllConnections();
    await Promise.all([close(gateway), close(upstream)]);
  });

  const pending = fetch(base + '/').catch(error => error);
  await new Promise(resolve => setTimeout(resolve, 30));
  const started = Date.now();
  await service.onModuleDestroy();
  assert.ok(Date.now() - started < 1000);
  const result = await pending;
  if (result instanceof Error) {
    assert.ok(result);
  } else {
    assert.equal(result.status, 503);
    await result.text();
  }
});

test('shutdown drains in-flight requests before aborting', async t => {
  const upstream = http.createServer((req, res) => {
    setTimeout(() => res.end('drained'), 80);
  });
  const url = await listen(upstream);
  const { gateway, service } = setup({ routes: [{ path: '/', upstreams: [url] }], shutdownTimeoutMs: 500 });
  const base = await listen(gateway);
  t.after(async () => {
    await Promise.all([close(gateway), close(upstream)]);
  });

  const pending = fetch(base + '/');
  const started = Date.now();
  while (service.inFlight.size === 0 && Date.now() - started < 500) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(service.inFlight.size, 1);
  await service.onModuleDestroy();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'drained');
});

test('successful half-open probe clears the sliding failure window', async t => {
  let mode = 'fail';
  const upstream = http.createServer((req, res) => {
    if (mode === 'ok') res.end('ok');
    else req.socket.destroy();
  });
  const url = await listen(upstream);
  const { gateway, service } = setup({
    routes: [{
      path: '/',
      upstreams: [url],
      circuitBreaker: { failureThreshold: 2, minimumRequests: 2, slidingWindowSize: 60, cooldownMs: 100 },
    }],
  });
  const base = await listen(gateway);
  t.after(async () => {
    service.onModuleDestroy();
    upstream.closeAllConnections();
    await Promise.all([close(gateway), close(upstream)]);
  });

  assert.equal((await fetch(base + '/')).status, 502);
  assert.equal((await fetch(base + '/')).status, 502);
  await new Promise(resolve => setTimeout(resolve, 120));
  mode = 'ok';
  assert.equal(await (await fetch(base + '/')).text(), 'ok');
  mode = 'fail';
  assert.equal((await fetch(base + '/')).status, 502);
  assert.equal(service.metrics().routes[0].upstreams[0].healthy, true);
});

test('outlier detection counts 5xx and decays ejection count', async t => {
  const upstream = http.createServer((req, res) => res.writeHead(500).end('bad'));
  const url = await listen(upstream);
  const { gateway, service } = setup({
    routes: [{
      path: '/',
      upstreams: [url],
      outlierDetection: { consecutive5xx: 2, baseEjectionTimeMs: 1000, intervalMs: 100 },
    }],
  });
  const base = await listen(gateway);
  await service.onModuleInit();
  t.after(async () => {
    service.onModuleDestroy();
    await Promise.all([close(gateway), close(upstream)]);
  });

  await (await fetch(base + '/')).text();
  await (await fetch(base + '/')).text();
  let node = service.metrics().routes[0].upstreams[0];
  assert.equal(node.consecutive5xx, 2);
  assert.equal(node.ejectionCount, 1);
  assert.ok(node.ejectedUntil > Date.now());

  assert.equal((await fetch(base + '/')).status, 503);
  await new Promise(resolve => setTimeout(resolve, 250));
  node = service.metrics().routes[0].upstreams[0];
  assert.equal(node.ejectionCount, 0);
});

test('health checks send configured method and headers', async t => {
  let seen;
  const upstream = http.createServer((req, res) => {
    seen = { method: req.method, headers: req.headers };
    res.writeHead(200).end();
  });
  const url = await listen(upstream);
  const { service } = setup({
    routes: [{
      path: '/',
      upstreams: [url],
      healthCheck: { path: '/health', intervalMs: 1000, method: 'HEAD', headers: { 'x-probe': 'yes' } },
    }],
  });
  await service.onModuleInit();
  t.after(async () => { service.onModuleDestroy(); await close(upstream); });

  assert.equal(seen.method, 'HEAD');
  assert.equal(seen.headers['x-probe'], 'yes');
});

test('failing health probes count toward the sliding circuit window', async t => {
  const upstream = http.createServer((req, res) => res.writeHead(500).end());
  const url = await listen(upstream);
  const { service } = setup({
    routes: [{
      path: '/',
      upstreams: [url],
      healthCheck: { path: '/health', intervalMs: 100, expectedStatus: [200] },
      circuitBreaker: { failureThreshold: 2, minimumRequests: 2, slidingWindowSize: 60, cooldownMs: 500 },
    }],
  });
  await service.onModuleInit();
  t.after(async () => { service.onModuleDestroy(); await close(upstream); });

  const deadline = Date.now() + 1000;
  while (service.metrics().routes[0].upstreams[0].healthy && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const node = service.metrics().routes[0].upstreams[0];
  assert.ok(node.healthCheckFailures >= 2);
  assert.equal(node.healthy, false);
});
