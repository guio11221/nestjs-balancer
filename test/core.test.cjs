'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectUpstream, sanitizeHeaders, registerStrategy } = require('../dist/index.js');
const { validateOptions, routeMatches } = require('../dist/options.js');
const { RouteBalancerService } = require('../dist/index.js');

function createRouteState(strategy = 'round-robin') {
  const options = validateOptions({
    routes: [
      {
        path: '/api',
        strategy,
        upstreams: [
          { url: 'http://127.0.0.1:3001', weight: 2 },
          { url: 'http://127.0.0.1:3002', weight: 1 },
        ],
      },
    ],
  });
  return options[0];
}

test('round-robin cycles through upstreams', () => {
  const route = createRouteState('round-robin');
  const urls = Array.from({ length: 4 }, () => selectUpstream(route).url);
  assert.deepEqual(urls, [
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3002',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3002',
  ]);
});

test('weighted-round-robin respects weights', () => {
  const route = createRouteState('weighted-round-robin');
  const urls = Array.from({ length: 6 }, () => selectUpstream(route).url);
  assert.deepEqual(urls, [
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3002',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3002',
    'http://127.0.0.1:3001',
  ]);
});

test('least-connections prefers upstream with lowest load', () => {
  const route = createRouteState('least-connections');
  route.upstreams[0].active = 3;
  assert.equal(selectUpstream(route).url, route.upstreams[1].url);
});

test('unhealthy upstream is excluded from selection', () => {
  const route = createRouteState('round-robin');
  route.upstreams[0].healthy = false;
  assert.equal(selectUpstream(route).url, route.upstreams[1].url);
});

test('returns undefined when no healthy upstream is available', () => {
  const route = createRouteState('round-robin');
  route.upstreams.forEach((upstream) => {
    upstream.healthy = false;
  });
  assert.equal(selectUpstream(route), undefined);
});

test('route prefix matching respects path boundaries', () => {
  assert.equal(routeMatches('/api', '/api/users'), true);
  assert.equal(routeMatches('/api', '/apix'), false);
});

test('rejects upstream with embedded credentials', () => {
  assert.throws(() => validateOptions({
    routes: [
      { path: '/api', upstreams: ['http://admin:secret@localhost:3001'] },
    ],
  }));
});

test('sanitizes hop-by-hop headers from Connection', () => {
  const headers = sanitizeHeaders({
    connection: 'x-private, keep-alive',
    'x-private': 'secret',
    'x-good': 'ok',
    upgrade: 'websocket',
  });
  assert.deepEqual(headers, { 'x-good': 'ok' });
});

test('supports custom strategy registration', () => {
  registerStrategy({
    name: 'last',
    select(_route, available) {
      return available.at(-1);
    },
  });
  assert.equal(selectUpstream(createRouteState('last')).url, 'http://127.0.0.1:3002');
});

test('rejects unsafe retry methods', () => {
  assert.throws(() => validateOptions({
    routes: [
      { path: '/', upstreams: ['http://localhost:3001'], retry: { methods: ['POST'] } },
    ],
  }), /Invalid retry policy/);
});

test('rejects malformed retry methods', () => {
  assert.throws(() => validateOptions({
    routes: [
      { path: '/', upstreams: ['http://localhost:3001'], retry: { methods: [42] } },
    ],
  }), /Invalid retry policy/);
});

test('rejects duplicate route paths', () => {
  assert.throws(() => validateOptions({
    routes: [
      { path: '/api/', upstreams: ['http://localhost:3001'] },
      { path: '/api', upstreams: ['http://localhost:3002'] },
    ],
  }), /Duplicate/);
});

test('rejects invalid upstream weights', () => {
  assert.throws(() => validateOptions({
    routes: [
      { path: '/', upstreams: [{ url: 'http://localhost:3001', weight: 0 }] },
    ],
  }), /Invalid weight/);
});

test('rejects route paths without leading slash', () => {
  assert.throws(() => validateOptions({
    routes: [
      { path: 'api', upstreams: ['http://localhost:3001'] },
    ],
  }), /Invalid route/);
});

test('rejects unsupported upstream protocols', () => {
  assert.throws(() => validateOptions({
    routes: [
      { path: '/', upstreams: ['file:///etc/passwd'] },
    ],
  }), /HTTP\(S\)/);
});

test('root route matches all nested paths', () => {
  assert.equal(routeMatches('/', '/anything/nested'), true);
});

test('custom strategy must select from available set', () => {
  registerStrategy({
    name: 'invalid-selector',
    select(route) {
      return route.upstreams[0];
    },
  });

  const route = createRouteState('invalid-selector');
  assert.throws(() => selectUpstream(route, [route.upstreams[1]]), /unavailable/);
});

test('rejects protocol-relative and backslash health-check paths', () => {
  assert.throws(() => validateOptions({
    routes: [
      { path: '/', upstreams: ['http://localhost:3001'], healthCheck: { path: '//evil.example/health', intervalMs: 1000 } },
    ],
  }), /Invalid healthCheck/);

  assert.throws(() => validateOptions({
    routes: [
      { path: '/', upstreams: ['http://localhost:3001'], healthCheck: { path: '/\\evil', intervalMs: 1000 } },
    ],
  }), /Invalid healthCheck/);
});

test('validates health-check expected status codes', () => {
  assert.throws(() => validateOptions({
    routes: [
      { path: '/', upstreams: ['http://localhost:3001'], healthCheck: { path: '/health', intervalMs: 1000, expectedStatus: [] } },
    ],
  }), /Invalid healthCheck/);

  assert.throws(() => validateOptions({
    routes: [
      { path: '/', upstreams: ['http://localhost:3001'], healthCheck: { path: '/health', intervalMs: 1000, expectedStatus: [99] } },
    ],
  }), /Invalid healthCheck/);

  assert.doesNotThrow(() => validateOptions({
    routes: [
      { path: '/', upstreams: ['http://localhost:3001'], healthCheck: { path: '/health?deep=1', intervalMs: 1000, expectedStatus: [200, 204] } },
    ],
  }));
});

test('validates boolean configuration flags', () => {
  assert.throws(() => validateOptions({ routes: [{ path: '/', upstreams: ['http://localhost:3001'] }], trustProxy: 'yes' }), /trustProxy/);
  assert.throws(() => validateOptions({ routes: [{ path: '/', upstreams: ['http://localhost:3001'] }], keepAlive: 1 }), /keepAlive/);
  assert.throws(() => validateOptions({ routes: [{ path: '/', upstreams: ['http://localhost:3001'], stripPrefix: 'yes' }] }), /stripPrefix/);
});

test('reports malformed upstream URLs clearly', () => {
  assert.throws(() => validateOptions({
    routes: [
      { path: '/', upstreams: ['not a url'] },
    ],
  }), /Invalid upstream URL/);
});

test('release clears a cancelled half-open probe', () => {
  const service = new RouteBalancerService({ routes: [{ path: '/', upstreams: ['http://127.0.0.1:1'], circuitBreaker: { cooldownMs: 100 } }] });
  const route = service.routes[0];
  const node = route.upstreams[0];

  service.failure(route, node);
  node.blockedUntil = Date.now() - 1;

  const acquired = service.acquire(route);
  assert.equal(acquired, node);
  assert.equal(node.probeInFlight, true);

  service.release(acquired);
  assert.equal(node.probeInFlight, false);

  assert.equal(service.acquire(route), node);

  service.onModuleDestroy();
});
