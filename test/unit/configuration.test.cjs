'use strict';

// Fluxo: validação da configuração pública antes de qualquer socket ser aberto.

const test = require('node:test');
const assert = require('node:assert/strict');

const { validate } = require('../helpers/options.cjs');
const { validateOptions } = require('../../dist/options.js');
const { RouteBalancerService } = require('../../dist/balancer.service.js');

test('rejects an upstream with embedded credentials', () => {
  assert.throws(
    () => validate({ routes: [{ path: '/api', upstreams: ['http://admin:secret@localhost:3001'] }] }),
    /Credentials not allowed/,
  );
});

test('rejects duplicate route paths after normalization', () => {
  assert.throws(
    () => validate({
      routes: [
        { path: '/api/', upstreams: ['http://localhost:3001'] },
        { path: '/api', upstreams: ['http://localhost:3002'] },
      ],
    }),
    /Duplicate/,
  );
});

test('rejects invalid upstream weights', () => {
  assert.throws(
    () => validate({ routes: [{ path: '/', upstreams: [{ url: 'http://localhost:3001', weight: 0 }] }] }),
    /Invalid weight/,
  );
});

test('rejects route paths without a leading slash or with unsafe characters', () => {
  assert.throws(
    () => validate({ routes: [{ path: 'api', upstreams: ['http://localhost:3001'] }] }),
    /Invalid route/,
  );
  assert.throws(
    () => validate({ routes: [{ path: '/api?debug=1', upstreams: ['http://localhost:3001'] }] }),
    /Invalid route/,
  );
  assert.throws(
    () => validate({ routes: [{ path: '/api\u0000admin', upstreams: ['http://localhost:3001'] }] }),
    /Invalid route/,
  );
  assert.throws(
    () => validate({ routes: [{ path: '/api\nadmin', upstreams: ['http://localhost:3001'] }] }),
    /Invalid route/,
  );
});

test('rejects unsupported upstream protocols and malformed URLs', () => {
  assert.throws(
    () => validate({ routes: [{ path: '/', upstreams: ['file:///etc/passwd'] }] }),
    /HTTP\(S\)/,
  );
  assert.throws(
    () => validate({ routes: [{ path: '/', upstreams: ['not a url'] }] }),
    /Invalid upstream URL/,
  );
});

test('rejects protocol-relative and backslash health-check paths', () => {
  assert.throws(
    () => validate({
      routes: [{
        path: '/',
        upstreams: ['http://localhost:3001'],
        healthCheck: { path: '//evil.example/health', intervalMs: 1000 },
      }],
    }),
    /Invalid healthCheck/,
  );

  assert.throws(
    () => validate({
      routes: [{
        path: '/',
        upstreams: ['http://localhost:3001'],
        healthCheck: { path: '/\\evil', intervalMs: 1000 },
      }],
    }),
    /Invalid healthCheck/,
  );
});

test('validates health-check status codes and query strings', () => {
  assert.throws(
    () => validate({
      routes: [{
        path: '/',
        upstreams: ['http://localhost:3001'],
        healthCheck: { path: '/health', intervalMs: 1000, expectedStatus: [] },
      }],
    }),
    /Invalid healthCheck/,
  );

  assert.throws(
    () => validate({
      routes: [{
        path: '/',
        upstreams: ['http://localhost:3001'],
        healthCheck: { path: '/health', intervalMs: 1000, expectedStatus: [99] },
      }],
    }),
    /Invalid healthCheck/,
  );

  assert.doesNotThrow(() => validate({
    routes: [{
      path: '/',
      upstreams: ['http://localhost:3001'],
      healthCheck: { path: '/health?deep=1', intervalMs: 1000, expectedStatus: [200, 204] },
    }],
  }));
});

test('validates boolean flags and shutdown timeout', () => {
  assert.throws(() => validate({ routes: [{ path: '/', upstreams: ['http://localhost:3001'] }], trustProxy: 'yes' }), /trustProxy/);
  assert.throws(() => validate({ routes: [{ path: '/', upstreams: ['http://localhost:3001'] }], keepAlive: 1 }), /keepAlive/);
  assert.throws(() => validate({ routes: [{ path: '/', upstreams: ['http://localhost:3001'], stripPrefix: 'yes' }] }), /stripPrefix/);
  assert.throws(() => validate({ routes: [{ path: '/', upstreams: ['http://localhost:3001'] }], shutdownTimeoutMs: 0 }), /shutdownTimeoutMs/);
});

test('requires a valid header name when consistent hashing uses header keys', () => {
  const route = (extra) => ({ path: '/', upstreams: ['http://localhost:3001'], strategy: 'consistent-hash', ...extra });

  assert.throws(() => validate({ routes: [route({ hashKey: 'header' })] }), /hashHeader is required/);
  assert.throws(() => validate({ routes: [route({ hashKey: 'header', hashHeader: 'bad header' })] }), /Invalid hashHeader/);
  assert.throws(() => validate({ routes: [route({ hashHeader: 42 })] }), /Invalid hashHeader/);
  assert.doesNotThrow(() => validate({ routes: [route({ hashKey: 'header', hashHeader: 'x-tenant' })] }));
});

test('rejects unsafe or malformed retry methods', () => {
  assert.throws(
    () => validate({ routes: [{ path: '/', upstreams: ['http://localhost:3001'], retry: { methods: ['POST'] } }] }),
    /Invalid retry policy/,
  );
  assert.throws(
    () => validate({ routes: [{ path: '/', upstreams: ['http://localhost:3001'], retry: { methods: [42] } }] }),
    /Invalid retry policy/,
  );
  assert.throws(
    () => validate({ routes: [{ path: '/', upstreams: ['http://localhost:3001'], retry: { retryOn: ['dns'] } }] }),
    /Invalid retry policy/,
  );
});

test('limits request plugin count and validates plugin shape', () => {
  const options = { routes: [{ path: '/', upstreams: ['http://localhost:3001'] }] };
  assert.throws(() => new RouteBalancerService(options, Array(33).fill({ onRequest() {} })), /at most 32/);
  assert.throws(() => new RouteBalancerService(options, [{ name: 'invalid' }]), /implementing onRequest/);
  const service = new RouteBalancerService(options, [{ onRequest() {} }]);
  service.onModuleDestroy();
});

test('validates request-interception timeout and header policies', () => {
  const options = { routes: [{ path: '/', upstreams: ['http://localhost:3001'] }] };
  assert.throws(
    () => validateOptions({ ...options, requestInterception: { timeoutMs: 0 } }),
    /requestInterception.timeoutMs/,
  );
  assert.throws(
    () => validateOptions({ ...options, requestInterception: { timeoutMs: 30001 } }),
    /requestInterception.timeoutMs/,
  );
  assert.throws(
    () => validateOptions({ ...options, requestInterception: { allowedHeaders: ['host'] } }),
    /allowedHeaders/,
  );
  assert.throws(
    () => validateOptions({ ...options, requestInterception: { exposedHeaders: ['x-forwarded-for'] } }),
    /exposedHeaders/,
  );
  assert.throws(
    () => validateOptions({ ...options, requestInterception: { allowedHeaders: ['x-good\\r\\nInjected'] } }),
    /allowedHeaders/,
  );
  assert.doesNotThrow(() => validateOptions({
    ...options,
    requestInterception: { timeoutMs: 1000, exposedHeaders: ['x-tenant'], allowedHeaders: ['x-tenant'] },
  }));
});

test('validates retry budget, timeouts and sticky cookie names', () => {
  assert.throws(
    () => validate({ routes: [{ path: '/', upstreams: ['http://localhost:3001'], retry: { maxRetryRate: 2 } }] }),
    /Invalid retry policy/,
  );
  assert.throws(
    () => validate({ routes: [{ path: '/', upstreams: ['http://localhost:3001'], timeouts: { headersTimeoutMs: -1 } }] }),
    /headersTimeoutMs/,
  );
  assert.throws(
    () => validate({ routes: [{ path: '/', upstreams: ['http://localhost:3001'], sticky: { cookie: 'lb; Path=/' } }] }),
    /Invalid sticky cookie/,
  );
});

test('rejects invalid health-check header names before starting probes', () => {
  const route = (headers) => ({
    path: '/api',
    upstreams: ['http://localhost:3001'],
    healthCheck: { path: '/health', intervalMs: 1000, headers },
  });

  for (const name of ['x bad', 'x:bad', 'x\\r\\nInjected', '']) {
    assert.throws(
      () => validate({ routes: [route({ [name]: 'value' })] }),
      /Invalid healthCheck headers/,
    );
  }

  assert.throws(
    () => validate({ routes: [route({ ['x'.repeat(257)]: 'value' })] }),
    /Invalid healthCheck headers/,
  );

  assert.doesNotThrow(() => validate({
    routes: [route({ 'x-health-check': 'ready', authorization: 'Bearer token' })],
  }));
});
