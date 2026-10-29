'use strict';

// Fluxo: estratégias de seleção. Nenhum teste abre sockets; apenas estado em memória.

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerStrategy, selectUpstream, RouteBalancerService } = require('../../dist/index.js');
const { createRouteState, validate } = require('../helpers/options.cjs');

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

test('weighted-round-robin respects configured weights', () => {
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

test('least-connections prefers the upstream with the lowest normalized load', () => {
  const route = createRouteState('least-connections');
  route.upstreams[0].active = 3;

  assert.equal(selectUpstream(route).url, route.upstreams[1].url);
});

test('least-response-time uses the lowest EWMA latency', () => {
  const route = createRouteState('least-response-time');
  route.upstreams[0].ewmaResponseTimeMs = 100;
  route.upstreams[1].ewmaResponseTimeMs = 25;

  assert.equal(selectUpstream(route).url, route.upstreams[1].url);
});

test('peak-ewma prefers the upstream with the lowest latency per weight', () => {
  const route = createRouteState('peak-ewma');
  const now = Date.now();
  route.upstreams[0].ewmaResponseTimeMs = 100;
  route.upstreams[0].ewmaObservedAt = now;
  route.upstreams[1].ewmaResponseTimeMs = 40;
  route.upstreams[1].ewmaObservedAt = now;

  assert.equal(selectUpstream(route).url, route.upstreams[1].url);
});

test('peak-ewma penalizes in-flight requests on an upstream', () => {
  const route = createRouteState('peak-ewma');
  const now = Date.now();
  for (const node of route.upstreams) {
    node.ewmaResponseTimeMs = 40;
    node.ewmaObservedAt = now;
  }
  assert.equal(selectUpstream(route).url, route.upstreams[0].url);

  route.upstreams[0].active = 3;
  assert.equal(selectUpstream(route).url, route.upstreams[1].url);
});

test('peak-ewma decays stale latency and probes untried upstreams', () => {
  const route = createRouteState('peak-ewma');
  const now = Date.now();
  route.upstreams[0].ewmaResponseTimeMs = 200;
  route.upstreams[0].ewmaObservedAt = now;
  route.upstreams[1].ewmaResponseTimeMs = 10;
  route.upstreams[1].ewmaObservedAt = now;
  assert.equal(selectUpstream(route).url, route.upstreams[1].url);

  // Latência antiga decai para perto de zero e o nó volta a ser candidato.
  route.upstreams[0].ewmaObservedAt = now - 60000;
  assert.equal(selectUpstream(route).url, route.upstreams[0].url);

  // Sem nenhuma amostra, o nó recebe uma requisição de aquecimento.
  route.upstreams[1].ewmaResponseTimeMs = 0;
  assert.equal(selectUpstream(route).url, route.upstreams[1].url);
});

test('p2c samples two upstreams and keeps the better score', () => {
  const route = createRouteState('p2c');
  const now = Date.now();
  route.upstreams[0].ewmaResponseTimeMs = 120;
  route.upstreams[0].ewmaObservedAt = now;
  route.upstreams[1].ewmaResponseTimeMs = 30;
  route.upstreams[1].ewmaObservedAt = now;

  for (let index = 0; index < 200; index += 1) {
    assert.equal(selectUpstream(route).url, route.upstreams[1].url);
  }
});

test('p2c breaks score ties by normalized load', () => {
  const route = createRouteState('p2c');
  const now = Date.now();
  for (const node of route.upstreams) {
    node.ewmaResponseTimeMs = 50;
    node.ewmaObservedAt = now;
  }
  // weight 2 vs 1 com a mesma latência: o nó mais pesado tem score menor.
  assert.equal(selectUpstream(route).url, route.upstreams[0].url);

  route.upstreams[0].active = 2;
  assert.equal(selectUpstream(route).url, route.upstreams[1].url);
});

test('recordLatency timestamps adaptive samples', () => {
  const service = new RouteBalancerService({ routes: [{ path: '/', upstreams: ['http://127.0.0.1:3001'] }] });
  const node = service.routes[0].upstreams[0];

  service.recordLatency(node, 42);
  assert.equal(node.ewmaResponseTimeMs, 42);
  assert.ok(node.ewmaObservedAt > 0);

  service.onModuleDestroy();
});

test('random selection only returns an available upstream', () => {
  const route = createRouteState('random');
  const available = [route.upstreams[1]];

  for (let index = 0; index < 25; index += 1) {
    assert.equal(selectUpstream(route, available).url, route.upstreams[1].url);
  }
});

test('unhealthy upstreams are excluded from selection', () => {
  const route = createRouteState('round-robin');
  route.upstreams[0].healthy = false;

  assert.equal(selectUpstream(route).url, route.upstreams[1].url);
});

test('returns undefined when no healthy upstream is available', () => {
  const route = createRouteState('round-robin');
  route.upstreams.forEach(upstream => {
    upstream.healthy = false;
  });

  assert.equal(selectUpstream(route), undefined);
});

test('supports custom strategy registration', () => {
  registerStrategy({
    name: 'test-last',
    select(_route, available) {
      return available.at(-1);
    },
  });

  assert.equal(selectUpstream(createRouteState('test-last')).url, 'http://127.0.0.1:3002');
});

test('custom strategy must select from the available set', () => {
  registerStrategy({
    name: 'test-invalid-selector',
    select(route) {
      return route.upstreams[0];
    },
  });

  const route = createRouteState('test-invalid-selector');
  assert.throws(
    () => selectUpstream(route, [route.upstreams[1]]),
    /unavailable/,
  );
});

test('consistent hashing keeps unaffected keys on their upstream', () => {
  const route = validate({
    routes: [{
      path: '/',
      strategy: 'consistent-hash',
      upstreams: [
        'http://127.0.0.1:3001',
        'http://127.0.0.1:3002',
        'http://127.0.0.1:3003',
      ],
    }],
  })[0];

  const keys = Array.from({ length: 500 }, (_, index) => `10.0.0.${index % 250}`);
  const before = new Map(keys.map(key => [
    key,
    selectUpstream(route, route.upstreams, { socket: { remoteAddress: key } }).url,
  ]));

  // Remove um nó e confirma que apenas as chaves dele foram remapeadas.
  const removed = route.upstreams[2];
  route.upstreams = route.upstreams.slice(0, 2);

  for (const key of keys) {
    if (before.get(key) === removed.url) continue;

    const selected = selectUpstream(route, route.upstreams, { socket: { remoteAddress: key } });
    assert.equal(selected.url, before.get(key), `key ${key} remapped unexpectedly`);
  }
});
