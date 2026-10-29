'use strict';

// Fluxo: montagem de headers do proxy. Nenhum socket é aberto.

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeHeaders, applyForwardedHeaders } = require('../../dist/proxy/headers.js');

test('untrusted proxies drop client forwarding metadata', () => {
  const headers = sanitizeHeaders({
    forwarded: 'for=1.2.3.4',
    'x-forwarded-for': '1.2.3.4',
    'x-forwarded-host': 'evil.example',
    'x-forwarded-proto': 'https',
    host: 'gateway.example',
    'x-keep': '1',
  });

  applyForwardedHeaders(headers, {
    trustProxy: false,
    remoteAddress: '10.0.0.1',
    protocol: 'http',
    host: 'gateway.example',
  });

  assert.deepEqual(headers, {
    host: 'gateway.example',
    'x-keep': '1',
    'x-forwarded-for': '10.0.0.1',
    'x-forwarded-host': 'gateway.example',
    'x-forwarded-proto': 'http',
  });
});

test('trusted chains append the peer without producing empty entries', () => {
  const headers = { 'x-forwarded-for': '   ', 'x-forwarded-host': '', 'x-forwarded-proto': '' };

  applyForwardedHeaders(headers, {
    trustProxy: true,
    remoteAddress: '10.0.0.2',
    protocol: 'https',
    host: 'api.example',
  });

  assert.equal(headers['x-forwarded-for'], '10.0.0.2');
  assert.equal(headers['x-forwarded-host'], 'api.example');
  assert.equal(headers['x-forwarded-proto'], 'https');
});

test('trusted existing values win and the peer is appended to the chain', () => {
  const headers = {
    'x-forwarded-for': '1.1.1.1',
    'x-forwarded-host': 'edge.example',
    'x-forwarded-proto': 'https',
  };

  applyForwardedHeaders(headers, {
    trustProxy: true,
    remoteAddress: '10.0.0.3',
    protocol: 'http',
    host: 'api.example',
  });

  assert.equal(headers['x-forwarded-for'], '1.1.1.1, 10.0.0.3');
  assert.equal(headers['x-forwarded-host'], 'edge.example');
  assert.equal(headers['x-forwarded-proto'], 'https');
});

test('x-forwarded-host is omitted when the client sent no Host', () => {
  const headers = {};

  applyForwardedHeaders(headers, {
    trustProxy: false,
    remoteAddress: '10.0.0.4',
    protocol: 'http',
  });

  assert.equal('x-forwarded-host' in headers, false);
  assert.equal('x-forwarded-proto' in headers, true);
  assert.equal(headers['x-forwarded-for'], '10.0.0.4');
});
