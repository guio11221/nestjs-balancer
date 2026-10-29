'use strict';

// Fluxo: controle em runtime (drain, peso, reload). Nenhum socket é aberto.

const test = require('node:test');
const assert = require('node:assert/strict');

const { RouteBalancerService, prometheusMetrics } = require('../../dist/index.js');

const A = 'http://127.0.0.1:3001';
const B = 'http://127.0.0.1:3002';
const C = 'http://127.0.0.1:3003';

function createService(routes, extra = {}) {
  return new RouteBalancerService({ routes, ...extra });
}

test('drained upstreams are excluded from selection and exported as a metric', () => {
  const service = createService([{ path: '/api', upstreams: [A, B] }]);
  const route = service.findRoute('/api');

  assert.equal(service.drainUpstream('/api', `${A}/`), true, 'origin normalization should accept a trailing slash');
  const selected = service.acquire(route);
  assert.equal(selected.url, B);
  service.release(selected);

  assert.equal(service.drainUpstream('/api', B), true);
  assert.equal(service.acquire(route), undefined);

  const metrics = service.metrics().routes[0].upstreams;
  assert.deepEqual(metrics.map(node => node.drained), [true, true]);
  assert.match(prometheusMetrics(service.metrics()), /route_balancer_upstream_drained\{route="\/api",upstream="http:\/\/127\.0\.0\.1:3001"\} 1/);

  assert.equal(service.resumeUpstream('/api', A), true);
  assert.equal(service.acquire(route).url, A);
  assert.equal(service.drainUpstream('/missing', A), false);
  assert.equal(service.resumeUpstream('/api', 'http://127.0.0.1:9999'), false);

  service.onModuleDestroy();
});

test('runtime weights are validated and applied to selection', () => {
  const service = createService([{ path: '/api', upstreams: [A, B], strategy: 'weighted-round-robin' }]);

  assert.equal(service.setUpstreamWeight('/api', A, 5), true);
  assert.equal(service.metrics().routes[0].upstreams[0].weight, 5);

  assert.throws(() => service.setUpstreamWeight('/api', A, 0), /between 1 and 1000/);
  assert.throws(() => service.setUpstreamWeight('/api', A, 1.5), /between 1 and 1000/);
  assert.throws(() => service.setUpstreamWeight('/api', A, 1001), /between 1 and 1000/);
  assert.equal(service.setUpstreamWeight('/api', 'http://127.0.0.1:9999', 2), false);

  const route = service.findRoute('/api');
  const counts = { [A]: 0, [B]: 0 };
  for (let index = 0; index < 6; index += 1) counts[service.acquire(route).url] += 1;
  assert.deepEqual(counts, { [A]: 5, [B]: 1 });

  service.onModuleDestroy();
});

test('reloadRoutes reports the diff and carries runtime state for unchanged upstreams', () => {
  const service = createService([{ path: '/api', upstreams: [A, B] }]);
  service.routes[0].upstreams[0].errors = 2;
  service.routes[0].upstreams[0].requests = 4;
  service.drainUpstream('/api', A);

  const result = service.reloadRoutes({
    routes: [
      { path: '/api', upstreams: [A, C], strategy: 'least-connections' },
      { path: '/v2', upstreams: [B] },
    ],
  });

  assert.deepEqual(result, { added: ['/v2'], removed: [], updated: ['/api'] });

  const api = service.findRoute('/api');
  assert.deepEqual(api.upstreams.map(node => node.url), [A, C]);
  assert.equal(api.upstreams[0].errors, 2);
  assert.equal(api.upstreams[0].requests, 4);
  assert.equal(api.upstreams[0].drained, true, 'drain state follows the same route path and upstream');
  assert.equal(api.upstreams[1].drained, false);
  // State is scoped per route path: moving an upstream to another route starts fresh.
  assert.equal(service.findRoute('/v2').upstreams[0].drained, false);
  assert.equal(service.findRoute('/v2').upstreams[0].url, B);

  service.onModuleDestroy();
});

test('reloadRoutes keeps in-flight bookkeeping out of the new snapshot', () => {
  const service = createService([{ path: '/api', upstreams: [A] }]);
  service.routes[0].upstreams[0].active = 1;

  service.reloadRoutes({ routes: [{ path: '/api', upstreams: [A] }] });

  assert.equal(service.findRoute('/api').upstreams[0].active, 0);
  service.onModuleDestroy();
});

test('reloadRoutes drops failure, request and retry windows for removed entries', () => {
  const service = createService([{ path: '/api', upstreams: [A, B] }]);
  const now = Date.now();
  for (const upstream of [A, B]) {
    service.failureWindow.set(`/api:${upstream}`, [now]);
    service.requestWindow.set(`/api:${upstream}`, [now]);
  }
  service.retryWindow.set('/api', { requests: [now], retries: [now] });

  service.reloadRoutes({ routes: [{ path: '/api', upstreams: [A] }] });
  assert.deepEqual([...service.failureWindow.keys()], [`/api:${A}`]);
  assert.deepEqual([...service.requestWindow.keys()], [`/api:${A}`]);
  assert.deepEqual([...service.retryWindow.keys()], ['/api']);

  service.reloadRoutes({ routes: [] });
  assert.equal(service.failureWindow.size, 0);
  assert.equal(service.requestWindow.size, 0);
  assert.equal(service.retryWindow.size, 0);
  service.onModuleDestroy();
});

test('outlier maintenance prunes windows using the configured circuit window', () => {
  const service = createService([{
    path: '/api',
    upstreams: [A],
    outlierDetection: { consecutive5xx: 2 },
    circuitBreaker: { slidingWindowSize: 10 },
  }]);
  const route = service.findRoute('/api');
  const key = `/api:${A}`;
  const stale = Date.now() - 15000;
  service.failureWindow.set(key, [stale]);
  service.requestWindow.set(key, [stale]);

  service.maintainOutliers(route, 30000);

  assert.deepEqual(service.failureWindow.get(key), []);
  assert.deepEqual(service.requestWindow.get(key), []);
  service.onModuleDestroy();
});

test('a health success does not release another upstream half-open probe', () => {
  const service = createService([{
    path: '/api',
    upstreams: [A, B, C],
    circuitBreaker: { failureThreshold: 1, cooldownMs: 100, maxHalfOpen: 1 },
  }]);
  const route = service.findRoute('/api');
  for (const node of route.upstreams) {
    service.failure(route, node);
    node.blockedUntil = 1;
  }

  const probe = service.acquire(route);
  assert.ok(probe);
  assert.equal(service.halfOpenCount.get('/api'), 1);

  const other = route.upstreams.find(node => node !== probe);
  service.success(other, route);
  service.drainUpstream('/api', other.url);

  assert.equal(service.acquire(route), undefined, 'maxHalfOpen still bounds the route');
  service.release(probe, route);
  assert.equal(service.halfOpenCount.get('/api'), 0);
  service.onModuleDestroy();
});

test('invalid reloads fail atomically and leave the previous table in place', () => {
  const service = createService([{ path: '/api', upstreams: [A] }]);

  assert.throws(() => service.reloadRoutes({ routes: [{ path: 'bad', upstreams: [A] }] }), /Invalid route/);
  assert.throws(() => service.reloadRoutes({ routes: [{ path: '/api', upstreams: ['file:///etc/passwd'] }] }), /HTTP\(S\)/);

  assert.ok(service.findRoute('/api'));
  assert.deepEqual(service.metrics().routes.map(route => route.path), ['/api']);

  service.onModuleDestroy();
});

test('reloadRoutes rejects bootstrap-only options and shutdown', async () => {
  const service = createService([{
    path: '/api',
    upstreams: [A],
  }], { requestInterception: { timeoutMs: 100, allowedHeaders: ['x-trace'] } });

  assert.doesNotThrow(() => service.reloadRoutes({
    routes: [{ path: '/api', upstreams: [A] }],
    requestInterception: { allowedHeaders: ['x-trace'], timeoutMs: 100 },
  }), 'equivalent static options with a different key order must be accepted');

  assert.throws(
    () => service.reloadRoutes({ routes: [{ path: '/api', upstreams: [A] }], trustProxy: true }),
    /Cannot change trustProxy/,
  );
  assert.throws(
    () => service.reloadRoutes({
      routes: [{ path: '/api', upstreams: [A] }],
      requestInterception: { allowedHeaders: ['x-tenant'] },
    }),
    /Cannot change requestInterception/,
  );
  assert.ok(service.findRoute('/api'));

  await service.onModuleDestroy();
  assert.throws(
    () => service.reloadRoutes({ routes: [{ path: '/api', upstreams: [A] }] }),
    /shutting down/,
  );
});

test('reloadRoutes rebuilds health-check and outlier timers', async () => {
  const service = createService([{ path: '/api', upstreams: [A], healthCheck: { path: '/health', intervalMs: 60000 } }]);
  await service.onModuleInit();
  assert.equal(service.timers.length, 1);

  service.reloadRoutes({
    routes: [
      { path: '/api', upstreams: [A], healthCheck: { path: '/health', intervalMs: 60000 } },
      { path: '/extra', upstreams: [B], outlierDetection: { consecutive5xx: 2 } },
    ],
  });
  assert.equal(service.timers.length, 2);

  service.reloadRoutes({ routes: [{ path: '/api', upstreams: [A] }] });
  assert.equal(service.timers.length, 0);

  await service.onModuleDestroy();
});
