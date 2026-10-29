'use strict';

/**
 * Fábricas mínimas para testes unitários de seleção/configuração.
 * Elas não sobem servidores e não criam agents, então são baratas e determinísticas.
 */

const { validateOptions } = require('../../dist/options.js');

const DEFAULT_UPSTREAMS = [
  { url: 'http://127.0.0.1:3001', weight: 2 },
  { url: 'http://127.0.0.1:3002', weight: 1 },
];

function validate(config) {
  return validateOptions(config);
}

function createRouteState(strategyOrOverrides = 'round-robin') {
  const overrides = typeof strategyOrOverrides === 'string'
    ? { strategy: strategyOrOverrides }
    : strategyOrOverrides;

  const [route] = validateOptions({
    routes: [{
      path: '/api',
      upstreams: DEFAULT_UPSTREAMS,
      ...overrides,
    }],
  });

  return route;
}

module.exports = {
  createRouteState,
  validate,
};
