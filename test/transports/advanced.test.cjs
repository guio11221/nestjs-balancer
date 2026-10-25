"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const http2 = require("node:http2");
const { once } = require("node:events");
const { createHttp2Balancer } = require("../../dist/transports/http2");
const { attachWebSocketBalancer } = require("../../dist/transports/websocket");
const { prometheusMetrics } = require("../../dist/telemetry/prometheus");
const { attachFastifyBalancer } = require("../../dist/adapters/fastify");
const { RouteBalancerService } = require("../../dist/balancer.service");
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}
test("prometheus escapes untrusted route labels and exposes counters", () => {
  const body = prometheusMetrics({
    routes: [
      {
        path: '/evil"\nnext',
        upstreams: [
          {
            url: "http://localhost:3000",
            healthy: true,
            active: 2,
            requests: 5,
            errors: 1,
            successes: 4,
            consecutiveFailures: 0,
          },
        ],
      },
    ],
  });
  assert.match(body, /route_balancer_upstream_requests_total/);
  assert.match(body, /route="\/evil\\"\\nnext"/);
  assert.match(body, /upstream_healthy.* 1/);
});
test("fastify hook ignores unmatched routes and hijacks matching routes", () => {
  let hook;
  let calls = 0;
  attachFastifyBalancer(
    {
      addHook: (_, callback) => {
        hook = callback;
      },
    },
    { findRoute: (p) => p === "/api" },
    {
      use: (_req, _res, done) => {
        calls++;
        done();
      },
    },
  );
  let done = 0;
  let hijack = 0;
  hook(
    { raw: { url: "/other" } },
    {
      raw: {},
      hijack() {
        hijack++;
      },
    },
    () => done++,
  );
  hook(
    { raw: { url: "/api?q=1" } },
    {
      raw: {},
      hijack() {
        hijack++;
      },
    },
    () => done++,
  );
  assert.deepEqual([done, hijack, calls], [2, 1, 1]);
});
test("HTTP/2 h2c forwards headers, body, and route prefix", async () => {
  const upstream = http2.createServer();
  upstream.on("stream", (stream, headers) => {
    let data = "";
    stream.on("data", (chunk) => (data += chunk));
    stream.on("end", () => {
      stream.respond({ ":status": 201, "content-type": "application/grpc" });
      stream.end(
        JSON.stringify({
          method: headers[":method"],
          path: headers[":path"],
          data,
        }),
      );
    });
  });
  const origin = await listen(upstream);
  const balancer = new RouteBalancerService({
    routes: [{ path: "/api", stripPrefix: true, upstreams: [origin] }],
  });
  const proxy = createHttp2Balancer(balancer);
  const endpoint = await listen(proxy);
  const session = http2.connect(endpoint);
  try {
    const req = session.request({
      ":method": "POST",
      ":path": "/api/items?x=1",
      "content-type": "application/grpc",
    });
    let status = 0;
    let data = "";
    req.on("response", (h) => (status = h[":status"]));
    req.on("data", (chunk) => (data += chunk));
    const done = once(req, "end");
    req.end("payload");
    await done;
    assert.equal(status, 201);
    assert.deepEqual(JSON.parse(data), {
      method: "POST",
      path: "/items?x=1",
      data: "payload",
    });
    assert.equal(balancer.metrics().routes[0].upstreams[0].active, 0);
  } finally {
    session.close();
    await close(proxy);
    await close(upstream);
    balancer.onModuleDestroy();
  }
});
test("WebSocket upgrade tunnels bidirectional raw bytes", async () => {
  const upstream = http.createServer();
  const backendSockets = new Set();
  let upgradeHeaders;
  upstream.on("upgrade", (req, socket, head) => {
    upgradeHeaders = req.headers;
    backendSockets.add(socket);
    socket.once("close", () => backendSockets.delete(socket));
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    if (head.length) socket.write(head);
    socket.on("data", (buffer) => socket.write(buffer));
    socket.resume();
  });
  const origin = await listen(upstream);
  const balancer = new RouteBalancerService({
    routes: [{ path: "/ws", upstreams: [origin] }],
  });
  const proxy = http.createServer();
  const dispose = attachWebSocketBalancer(proxy, balancer);
  const endpoint = await listen(proxy);
  try {
    const url = new URL(endpoint);
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: "/ws",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    });
    const result = new Promise((resolve, reject) => {
      req.once("upgrade", (_res, socket, head) => {
        if (head.length) {
          resolve(head.toString());
          socket.destroy();
          return;
        }
        socket.once("data", (chunk) => {
          resolve(chunk.toString());
          socket.destroy();
        });
        socket.resume();
        socket.write("hello");
      });
      req.once("error", reject);
    });
    req.end();
    assert.equal(await result, "hello");
    assert.ok(upgradeHeaders["x-forwarded-for"].includes("127.0.0.1"));
    assert.equal(upgradeHeaders.forwarded, undefined);
  } finally {
    dispose();
    for (const socket of backendSockets) socket.destroy();
    await close(proxy);
    await close(upstream);
    balancer.onModuleDestroy();
  }
});
test("WebSocket releases the upstream when the backend closes first", async () => {
  const upstream = http.createServer();
  upstream.on("upgrade", (req, socket, head) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    if (head.length) socket.write(head);
    socket.resume();
    setTimeout(() => socket.destroy(), 20);
  });
  const origin = await listen(upstream);
  const balancer = new RouteBalancerService({
    routes: [{ path: "/ws", upstreams: [origin] }],
  });
  const proxy = http.createServer();
  const dispose = attachWebSocketBalancer(proxy, balancer);
  const endpoint = await listen(proxy);
  try {
    const url = new URL(endpoint);
    await new Promise((resolve, reject) => {
      const req = http.request({
        host: url.hostname,
        port: url.port,
        path: "/ws",
        headers: { Connection: "Upgrade", Upgrade: "websocket" },
      });
      req.once("upgrade", (_res, socket) => {
        socket.once("close", resolve);
        socket.resume();
      });
      req.once("error", reject);
      req.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(balancer.metrics().routes[0].upstreams[0].active, 0);
  } finally {
    dispose();
    await close(proxy);
    await close(upstream);
    balancer.onModuleDestroy();
  }
});
test("HTTP/2 rejects unmatched routes without acquiring upstream", async () => {
  const balancer = new RouteBalancerService({
    routes: [{ path: "/known", upstreams: ["http://127.0.0.1:12345"] }],
  });
  const proxy = createHttp2Balancer(balancer);
  const origin = await listen(proxy);
  const session = http2.connect(origin);
  try {
    const req = session.request({ ":path": "/other" });
    const result = once(req, "response");
    req.end();
    const [headers] = await result;
    assert.equal(headers[":status"], 404);
    await once(req, "end");
    assert.equal(balancer.metrics().routes[0].upstreams[0].requests, 0);
  } finally {
    session.close();
    await close(proxy);
    balancer.onModuleDestroy();
  }
});
test("WebSocket rejects unmatched upgrade requests", async () => {
  const balancer = new RouteBalancerService({
    routes: [{ path: "/ws", upstreams: ["http://127.0.0.1:12345"] }],
  });
  const proxy = http.createServer();
  const dispose = attachWebSocketBalancer(proxy, balancer);
  const origin = await listen(proxy);
  try {
    const url = new URL(origin);
    const result = await new Promise((resolve) => {
      const req = http.request({
        host: url.hostname,
        port: url.port,
        path: "/other",
        headers: { Connection: "Upgrade", Upgrade: "websocket" },
      });
      req.once("error", (err) => resolve(err.code));
      req.once("response", (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.end();
    });
    assert.ok(result === "ECONNRESET" || result === "EPIPE");
  } finally {
    dispose();
    await close(proxy);
    balancer.onModuleDestroy();
  }
});
