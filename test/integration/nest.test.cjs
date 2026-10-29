'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('reflect-metadata');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { RouteBalancerModule, RouteBalancerService } = require('../../dist/index.js');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('NestJS module registers the wildcard middleware and proxies configured routes', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url }));
  });
  const upstreamUrl = await listen(upstream);

  class AppModule {}
  Module({
    imports: [RouteBalancerModule.forRoot({ routes: [{ path: '/api', upstreams: [upstreamUrl] }] })],
  })(AppModule);

  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  t.after(async () => {
    await app.close();
    await close(upstream);
  });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const base = `http://127.0.0.1:${address.port}`;

  const proxied = await fetch(`${base}/api/items?q=1`);
  assert.equal(proxied.status, 200);
  assert.deepEqual(await proxied.json(), { path: '/api/items?q=1' });

  const unmatched = await fetch(`${base}/other`);
  assert.equal(unmatched.status, 404);
});

test('NestJS module supports forRootAsync with imported configuration providers', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url }));
  });
  const upstreamUrl = await listen(upstream);
  let app;
  t.after(async () => {
    if (app) await app.close();
    await close(upstream);
  });

  class ConfigurationModule {}
  Module({
    providers: [{ provide: 'BALANCER_CONFIGURATION', useValue: { upstreamUrl } }],
    exports: ['BALANCER_CONFIGURATION'],
  })(ConfigurationModule);

  class AsyncAppModule {}
  Module({
    imports: [RouteBalancerModule.forRootAsync({
      imports: [ConfigurationModule],
      inject: ['BALANCER_CONFIGURATION'],
      useFactory: async (configuration) => ({
        routes: [{ path: '/async-api', upstreams: [configuration.upstreamUrl] }],
      }),
    })],
  })(AsyncAppModule);

  app = await NestFactory.create(AsyncAppModule, { bodyParser: false, logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const response = await fetch(`http://127.0.0.1:${address.port}/async-api/items`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: '/async-api/items' });
});

test('NestJS request plugins run in provider order with bounded path and header changes', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url, tenant: req.headers['x-tenant'], authorization: req.headers.authorization, trace: req.headers['x-trace'] }));
  });
  const upstreamUrl = await listen(upstream);
  let app;
  const observed = [];
  t.after(async () => {
    if (app) await app.close();
    await close(upstream);
  });

  class PluginModule {}
  Module({
    providers: [
      { provide: 'PLUGIN_ONE', useValue: { onRequest(context) {
        observed.push({
          stage: 1,
          method: context.method,
          pathname: context.pathname,
          authorization: context.headers.authorization,
          trace: context.headers['x-trace'],
          frozenContext: Object.isFrozen(context) && Object.isFrozen(context.headers),
        });
        return { pathname: '/api/rewritten', headers: { 'x-tenant': 'first' } };
      } } },
      { provide: 'PLUGIN_TWO', useValue: { onRequest(context) {
        observed.push({ stage: 2, pathname: context.pathname, tenant: context.headers['x-tenant'] });
        return { headers: { 'x-tenant': 'second' } };
      } } },
    ],
    exports: ['PLUGIN_ONE', 'PLUGIN_TWO'],
  })(PluginModule);

  class PluginAppModule {}
  Module({
    imports: [RouteBalancerModule.forRootAsync({
      imports: [PluginModule],
      inject: [],
      plugins: { inject: ['PLUGIN_ONE', 'PLUGIN_TWO'] },
      useFactory: () => ({
        routes: [{ path: '/api', upstreams: [upstreamUrl] }],
        requestInterception: { exposedHeaders: ['x-trace'], allowedHeaders: ['x-tenant'] },
      }),
    })],
  })(PluginAppModule);

  app = await NestFactory.create(PluginAppModule, { bodyParser: false, logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/original?q=1`, {
    headers: { authorization: 'must-not-be-exposed', 'x-trace': 'trace-test' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    path: '/api/rewritten?q=1', tenant: 'second', authorization: 'must-not-be-exposed', trace: 'trace-test',
  });
  assert.deepEqual(observed, [
    { stage: 1, method: 'GET', pathname: '/api/original', authorization: undefined, trace: 'trace-test', frozenContext: true },
    { stage: 2, pathname: '/api/original', tenant: undefined },
  ]);
  const balancer = app.get(RouteBalancerService);
  assert.equal(balancer.metrics().routes[0].upstreams[0].requests, 1);
});

test('synchronous plugin registration resolves providers from its own module scope', async (t) => {
  const upstream = http.createServer((req, res) => res.end(req.headers['x-sync-plugin'] || 'missing'));
  const upstreamUrl = await listen(upstream);
  let app;
  t.after(async () => {
    if (app) await app.close();
    await close(upstream);
  });

  class PluginAppModule {}
  Module({
    imports: [RouteBalancerModule.forRoot({
      routes: [{ path: '/sync', upstreams: [upstreamUrl] }],
      requestInterception: { allowedHeaders: ['x-sync-plugin'] },
    }, {
      providers: [{ provide: 'SYNC_PLUGIN', useValue: { onRequest: () => ({ headers: { 'x-sync-plugin': 'resolved' } }) } }],
      inject: ['SYNC_PLUGIN'],
    })],
  })(PluginAppModule);

  app = await NestFactory.create(PluginAppModule, { bodyParser: false, logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const response = await fetch(`http://127.0.0.1:${address.port}/sync/ready`);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'resolved');
});

test('request plugins reject before any upstream request when path escapes the matched route', async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    res.end('should not be reached');
  });
  const upstreamUrl = await listen(upstream);
  let app;
  t.after(async () => {
    if (app) await app.close();
    await close(upstream);
  });

  class PluginAppModule {}
  Module({
    imports: [RouteBalancerModule.forRoot({
      routes: [{ path: '/api', upstreams: [upstreamUrl] }],
      requestInterception: { allowedHeaders: ['x-tenant'] },
    }, {
      providers: [{ provide: 'ESCAPE_PLUGIN', useValue: { onRequest: () => ({ pathname: '/admin' }) } }],
      inject: ['ESCAPE_PLUGIN'],
    })],
  })(PluginAppModule);

  app = await NestFactory.create(PluginAppModule, { bodyParser: false, logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/items`);

  assert.equal(response.status, 400);
  assert.equal(upstreamRequests, 0);
});

test('separately configured balancer modules do not share their plugin instances', async (t) => {
  const upstream = http.createServer((req, res) => res.end(req.headers['x-module-plugin'] || 'missing'));
  const upstreamUrl = await listen(upstream);
  let app;
  t.after(async () => {
    if (app) await app.close();
    await close(upstream);
  });

  class AppModule {}
  Module({
    imports: [
      RouteBalancerModule.forRoot({
        routes: [{ path: '/one', upstreams: [upstreamUrl] }],
        requestInterception: { allowedHeaders: ['x-module-plugin'] },
      }, {
        providers: [{ provide: 'SCOPED_PLUGIN', useValue: { onRequest: () => ({ headers: { 'x-module-plugin': 'one' } }) } }],
        inject: ['SCOPED_PLUGIN'],
      }),
      RouteBalancerModule.forRoot({
        routes: [{ path: '/two', upstreams: [upstreamUrl] }],
        requestInterception: { allowedHeaders: ['x-module-plugin'] },
      }, {
        providers: [{ provide: 'SCOPED_PLUGIN', useValue: { onRequest: () => ({ headers: { 'x-module-plugin': 'two' } }) } }],
        inject: ['SCOPED_PLUGIN'],
      }),
    ],
  })(AppModule);

  app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal(await (await fetch(`${base}/one/item`)).text(), 'one');
  assert.equal(await (await fetch(`${base}/two/item`)).text(), 'two');
});

test('request plugins reject protected header mutations before contacting upstream', async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    res.end('should not be reached');
  });
  const upstreamUrl = await listen(upstream);
  let app;
  t.after(async () => {
    if (app) await app.close();
    await close(upstream);
  });

  class AppModule {}
  Module({
    imports: [RouteBalancerModule.forRoot({ routes: [{ path: '/api', upstreams: [upstreamUrl] }] }, {
      providers: [{ provide: 'PROTECTED_HEADER_PLUGIN', useValue: {
        onRequest: () => ({ headers: { host: 'attacker.invalid' } }),
      } }],
      inject: ['PROTECTED_HEADER_PLUGIN'],
    })],
  })(AppModule);

  app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/items`);

  assert.equal(response.status, 500);
  assert.equal((await response.json()).message, 'Request plugin attempted to modify a protected header');
  assert.equal(upstreamRequests, 0);
});

test('client disconnect aborts pending plugin work without reaching upstream', async (t) => {
  let upstreamRequests = 0;
  let pluginSignal;
  let pluginStartedResolve;
  let pluginAbortedResolve;
  const pluginStarted = new Promise(resolve => { pluginStartedResolve = resolve; });
  const pluginAborted = new Promise(resolve => { pluginAbortedResolve = resolve; });
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    res.end('should not be reached');
  });
  const upstreamUrl = await listen(upstream);
  let app;
  let request;
  t.after(async () => {
    request?.destroy();
    if (app) await app.close();
    await close(upstream);
  });

  class AppModule {}
  Module({
    imports: [RouteBalancerModule.forRoot({ routes: [{ path: '/api', upstreams: [upstreamUrl] }] }, {
      providers: [{ provide: 'CANCELLABLE_PLUGIN', useValue: { onRequest(context) {
        pluginSignal = context.signal;
        pluginStartedResolve();
        return new Promise(resolve => context.signal.addEventListener('abort', () => {
          pluginAbortedResolve();
          resolve(undefined);
        }, { once: true }));
      } } }],
      inject: ['CANCELLABLE_PLUGIN'],
    })],
  })(AppModule);

  app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  request = http.get(`http://127.0.0.1:${address.port}/api/cancel`);
  request.on('error', () => {});
  await pluginStarted;
  request.destroy();
  await pluginAborted;
  assert.equal(pluginSignal.aborted, true);
  assert.equal(upstreamRequests, 0);
});

test('request plugins reject malformed header values without contacting upstream', async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    res.end('should not be reached');
  });
  const upstreamUrl = await listen(upstream);
  let app;
  t.after(async () => {
    if (app) await app.close();
    await close(upstream);
  });

  class AppModule {}
  Module({
    imports: [RouteBalancerModule.forRoot({
      routes: [{ path: '/api', upstreams: [upstreamUrl] }],
      requestInterception: { allowedHeaders: ['x-tenant'] },
    }, {
      providers: [{ provide: 'BAD_VALUE_PLUGIN', useValue: {
        onRequest: () => ({ headers: { 'x-tenant': `bad${String.fromCharCode(127)}value` } }),
      } }],
      inject: ['BAD_VALUE_PLUGIN'],
    })],
  })(AppModule);

  app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/items`);

  assert.equal(response.status, 500);
  assert.equal((await response.json()).message, 'Request plugin returned an invalid header value');
  assert.equal(upstreamRequests, 0);
});

test('request plugins fail closed for thrown exceptions and malformed decisions', async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    res.end('should not be reached');
  });
  const upstreamUrl = await listen(upstream);
  let app;
  t.after(async () => {
    if (app) await app.close();
    await close(upstream);
  });

  class PluginAppModule {}
  Module({
    imports: [RouteBalancerModule.forRoot({
      routes: [{ path: '/api', upstreams: [upstreamUrl] }],
      requestInterception: { allowedHeaders: ['x-tenant'] },
    }, {
      providers: [{ provide: 'THROW_PLUGIN', useValue: { onRequest: () => { throw new Error('secret internal detail'); } } }],
      inject: ['THROW_PLUGIN'],
    })],
  })(PluginAppModule);

  app = await NestFactory.create(PluginAppModule, { bodyParser: false, logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const base = `http://127.0.0.1:${address.port}`;
  const thrown = await fetch(`${base}/api/throw`);
  assert.equal(thrown.status, 500);
  assert.equal((await thrown.json()).message, 'Request interception failed');
  const balancer = app.get(RouteBalancerService);
  await balancer.onModuleDestroy();
  assert.equal(upstreamRequests, 0);
});

test('request plugin shutdown aborts pending work and cleans up the request lifecycle', async (t) => {
  let upstreamRequests = 0;
  let pluginSignal;
  let pluginStartedResolve;
  let pluginAbortedResolve;
  const pluginStarted = new Promise(resolve => { pluginStartedResolve = resolve; });
  const pluginAborted = new Promise(resolve => { pluginAbortedResolve = resolve; });
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    res.end('should not be reached');
  });
  const upstreamUrl = await listen(upstream);
  let app;
  let request;
  t.after(async () => {
    request?.destroy();
    if (app) await app.close();
    await close(upstream);
  });

  class AppModule {}
  Module({
    imports: [RouteBalancerModule.forRoot({
      routes: [{ path: '/api', upstreams: [upstreamUrl] }],
      shutdownTimeoutMs: 500,
      requestInterception: { timeoutMs: 1000 },
    }, {
      providers: [{ provide: 'SHUTDOWN_PLUGIN', useValue: { onRequest(context) {
        pluginSignal = context.signal;
        pluginStartedResolve();
        return new Promise(resolve => context.signal.addEventListener('abort', () => {
          pluginAbortedResolve();
          resolve(undefined);
        }, { once: true }));
      } } }],
      inject: ['SHUTDOWN_PLUGIN'],
    })],
  })(AppModule);

  app = await NestFactory.create(AppModule, { bodyParser: false, logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  request = http.get(`http://127.0.0.1:${address.port}/api/shutdown`);
  request.on('error', () => {});
  await pluginStarted;
  const balancer = app.get(RouteBalancerService);
  await balancer.onModuleDestroy();
  await pluginAborted;

  assert.equal(pluginSignal.aborted, true);
  assert.equal(balancer.isShuttingDown(), true);
  assert.equal(upstreamRequests, 0);
  assert.equal(balancer.inFlight.size, 0);
});

test('request plugin timeout fails closed and does not contact upstream', async (t) => {
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    res.end('should not be reached');
  });
  const upstreamUrl = await listen(upstream);
  let app;
  let pluginSignal;
  t.after(async () => {
    if (app) await app.close();
    await close(upstream);
  });

  class PluginAppModule {}
  Module({
    imports: [RouteBalancerModule.forRoot({
      routes: [{ path: '/api', upstreams: [upstreamUrl] }],
      requestInterception: { timeoutMs: 50 },
    }, {
      providers: [{ provide: 'SLOW_PLUGIN', useValue: { onRequest(context) {
        pluginSignal = context.signal;
        return new Promise(() => {});
      } } }],
      inject: ['SLOW_PLUGIN'],
    })],
  })(PluginAppModule);

  app = await NestFactory.create(PluginAppModule, { bodyParser: false, logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/items`);

  assert.equal(response.status, 504);
  assert.equal(upstreamRequests, 0);
  assert.equal(pluginSignal.aborted, true);
});
