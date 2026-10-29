'use strict';

// Fluxo: resolução de rota por prefixo, incluindo borda de path e prioridade.

const test = require('node:test');
const assert = require('node:assert/strict');

const { RouteBalancerService } = require('../../dist/index.js');
const { routeMatches } = require('../../dist/options.js');

test('route prefix matching respects path boundaries', () => {
  assert.equal(routeMatches('/api', '/api'), true);
  assert.equal(routeMatches('/api', '/api/users'), true);
  assert.equal(routeMatches('/api', '/apix'), false);
  assert.equal(routeMatches('/api', '/api-v2/users'), false);
});

test('root route matches every nested path', () => {
  assert.equal(routeMatches('/', '/'), true);
  assert.equal(routeMatches('/', '/anything/nested'), true);
});

test('service selects the longest matching prefix', () => {
  const service = new RouteBalancerService({
    routes: [
      { path: '/', upstreams: ['http://127.0.0.1:3001'] },
      { path: '/api', upstreams: ['http://127.0.0.1:3002'] },
      { path: '/api/admin', upstreams: ['http://127.0.0.1:3003'] },
    ],
  });

  try {
    assert.equal(service.findRoute('/api/admin/users')?.path, '/api/admin');
    assert.equal(service.findRoute('/api/public')?.path, '/api');
    assert.equal(service.findRoute('/other')?.path, '/');
  } finally {
    service.onModuleDestroy();
  }
});

test('trailing slashes are normalized during configuration', () => {
  const service = new RouteBalancerService({
    routes: [{ path: '/api/', upstreams: ['http://127.0.0.1:3001'] }],
  });

  try {
    assert.equal(service.findRoute('/api')?.path, '/api');
    assert.equal(service.findRoute('/api/users')?.path, '/api');
  } finally {
    service.onModuleDestroy();
  }
});
