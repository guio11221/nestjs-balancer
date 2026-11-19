'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBackoff } = require('../../dist/utils/backoff.js');

test('caps exponential retry delays, including huge retry counts', () => {
  assert.equal(computeBackoff(100, 1), 100);
  assert.equal(computeBackoff(100, 2), 200);
  assert.equal(computeBackoff(100, 10000), 30000);
});

test('returns finite nonnegative delays for malformed numerical inputs', () => {
  const cases = [
    [NaN, 1],
    [Infinity, 1],
    [-Infinity, 1],
    [100, NaN],
    [100, Infinity],
    [100, -Infinity],
    [100, 5, NaN],
    [100, 5, Infinity],
    [100, 5, 10, NaN],
    [100, 5, 10, Infinity],
    [100, 5, 10, 0],
  ];

  for (const args of cases) {
    const delay = computeBackoff(...args);
    assert.ok(Number.isFinite(delay), `expected finite delay for ${String(args)}`);
    assert.ok(delay >= 0 && delay <= 30000, `expected bounded delay for ${String(args)}`);
  }
});

test('keeps jitter within retry bounds', () => {
  for (let i = 0; i < 100; i += 1) {
    const delay = computeBackoff(1000, 2, 2000, 3000);
    assert.ok(delay >= 0 && delay <= 3000);
  }
});
