'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectUpstream, sanitizeHeaders, registerStrategy } = require('../dist/index.js');
const { validateOptions, routeMatches } = require('../dist/options.js');
const { RouteBalancerService } = require('../dist/index.js');
const { validateUpstreamOrigin } = require('../dist/utils/ssrf.js');
const { computeBackoff } = require('../dist/utils/backoff.js');
const { classifyError } = require('../dist/utils/errors.js');
const { buildStickyCookie, resolveStickyUpstream } = require('../dist/utils/sticky.js');

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

test('rejects IPv6 literal private and mapped SSRF targets', () => {
  const strict = { allowPrivate: false, allowLocalhost: false };
  for (const origin of [
    'http://[fd00::1]',
    'http://[2001:db8::1]',
    'http://[::1]',
    'http://[::127.0.0.1]',
    'http://[::ffff:7f00:1]',
    'http://[::ffff:169.254.169.254]',
    'http://0.0.0.0:1234',
    'http://169.254.169.254',
  ]) {
    assert.equal(validateUpstreamOrigin(origin, strict).valid, false, origin);
  }
  assert.equal(validateUpstreamOrigin('http://127.0.0.1:3001', { allowPrivate: false }).valid, false);
  assert.equal(validateUpstreamOrigin('http://[::1]', { allowPrivate: false, allowLocalhost: true }).valid, true);
  assert.equal(validateUpstreamOrigin('http://127.0.0.1:3001', { allowPrivate: false, allowLocalhost: true }).valid, true);
  assert.equal(validateUpstreamOrigin('http://[fd00::1]', { allowPrivate: true }).valid, true);
  assert.equal(validateUpstreamOrigin('http://[::ffff:169.254.169.254]', { allowPrivate: false, allowLinkLocal: true }).valid, true);
});

test('SSRF options honor explicit denials, trailing dots, and host patterns', () => {
  assert.equal(
    validateUpstreamOrigin('http://127.0.0.1:3001', { allowPrivate: true, allowLocalhost: false }).valid,
    false,
    'explicit allowLocalhost:false must override allowPrivate',
  );
  assert.equal(
    validateUpstreamOrigin('http://[::127.0.0.1]', { allowPrivate: true, allowLocalhost: false }).valid,
    false,
    'IPv4-compatible loopback must be treated as loopback',
  );
  assert.equal(
    validateUpstreamOrigin('http://[::ffff:127.0.0.1]', { allowPrivate: true, allowLocalhost: false }).valid,
    false,
    'IPv4-mapped loopback must be treated as loopback',
  );
  assert.equal(
    validateUpstreamOrigin('http://localhost:3001', { allowPrivate: true, allowLocalhost: false }).valid,
    false,
  );
  assert.equal(
    validateUpstreamOrigin('http://127.0.0.1.:3001', { allowPrivate: false, allowLocalhost: false }).valid,
    false,
    'a trailing dot must not bypass loopback detection',
  );
  assert.equal(
    validateUpstreamOrigin('http://localhost.:3001', { allowPrivate: false, allowLocalhost: false }).valid,
    false,
  );
  assert.equal(
    validateUpstreamOrigin('http://169.254.169.254', { allowPrivate: true, allowLinkLocal: false }).valid,
    false,
    'explicit allowLinkLocal:false must override allowPrivate',
  );
  assert.equal(
    validateUpstreamOrigin('http://169.254.169.254', { allowPrivate: true }).valid,
    false,
    'link-local targets require allowLinkLocal rather than allowPrivate',
  );

  assert.equal(validateUpstreamOrigin('http://api.example.com', { allowlist: ['*.example.com'] }).valid, true);
  assert.equal(validateUpstreamOrigin('http://example.com', { allowlist: ['*.example.com'] }).valid, true);
  assert.equal(validateUpstreamOrigin('http://example.org', { allowlist: ['*.example.com'] }).valid, false);
  assert.equal(validateUpstreamOrigin('http://api.example.com', { allowlist: ['example.com'] }).valid, false);
  assert.equal(validateUpstreamOrigin('http://api.evil.com', { blocklist: ['*.evil.com'] }).valid, false);
  assert.equal(validateUpstreamOrigin('http://api.evil.com', { blocklist: ['evil.com'] }).valid, true);
});

test('consistent hashing keeps unaffected keys on their upstream', () => {
  const route = validateOptions({
    routes: [{
      path: '/',
      strategy: 'consistent-hash',
      upstreams: ['http://127.0.0.1:3001', 'http://127.0.0.1:3002', 'http://127.0.0.1:3003'],
    }],
  })[0];
  const keys = Array.from({ length: 500 }, (_, index) => `10.0.0.${index % 250}`);
  const before = new Map(keys.map(key => [key, selectUpstream(route, route.upstreams, { socket: { remoteAddress: key } }).url]));
  const removed = route.upstreams[2];
  route.upstreams = route.upstreams.slice(0, 2);
  for (const key of keys) {
    if (before.get(key) === removed.url) continue;
    const selected = selectUpstream(route, route.upstreams, { socket: { remoteAddress: key } });
    assert.equal(selected.url, before.get(key), `key ${key} remapped unexpectedly`);
  }
});

test('backoff is exponential, capped and jitter-safe', () => {
  assert.equal(computeBackoff(25, 1, 0, 1000), 25);
  assert.equal(computeBackoff(25, 4, 0, 1000), 200);
  assert.equal(computeBackoff(25, 10, 0, 1000), 1000);
  const jittered = computeBackoff(100, 3, 10, 1000);
  assert.ok(jittered >= 390 && jittered <= 410);
});

test('classifies retry reasons from transport errors', () => {
  assert.equal(classifyError({ code: 'ECONNECTTIMEOUT' }), 'connect');
  assert.equal(classifyError({ code: 'ECONNREFUSED' }), 'connect');
  assert.equal(classifyError({ code: 'ETIMEDOUT' }), 'timeout');
  assert.equal(classifyError({ code: 'ECONNRESET' }), 'network');
  assert.equal(classifyError(new Error('boom')), 'network');
});

test('sticky tokens are opaque, signed and reject tampering or empty values', () => {
  const route = validateOptions({
    routes: [{ path: '/api', upstreams: ['http://127.0.0.1:3001', 'http://127.0.0.1:3002'], sticky: { cookie: 'lb', ttlMs: 60000, sameSite: 'strict' } }],
  })[0];
  const options = route.config.sticky;
  const cookie = buildStickyCookie(route, route.upstreams[1].url, options, 'secret');
  assert.equal(cookie.includes('127.0.0.1'), false);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /HttpOnly/);
  const pair = cookie.split(';')[0];
  assert.equal(resolveStickyUpstream(route, pair, options, 'secret'), route.upstreams[1].url);
  assert.equal(resolveStickyUpstream(route, 'lb=', options, 'secret'), undefined);
  assert.equal(resolveStickyUpstream(route, 'lb=deadbeef', options, 'secret'), undefined);
  assert.equal(resolveStickyUpstream(route, pair, options, 'other-secret'), undefined);
});

test('retry budget blocks retries at rate zero and allows them otherwise', () => {
  const blocked = new RouteBalancerService({ routes: [{ path: '/', upstreams: ['http://127.0.0.1:1'], retry: { maxRetryRate: 0 } }] });
  assert.equal(blocked.tryReserveRetry(blocked.routes[0]), false);
  blocked.onModuleDestroy();

  const allowed = new RouteBalancerService({ routes: [{ path: '/', upstreams: ['http://127.0.0.1:1'], retry: { maxRetryRate: 1 } }] });
  assert.equal(allowed.tryReserveRetry(allowed.routes[0]), true);
  allowed.onModuleDestroy();
});
