# Reproducible performance benchmarks

No throughput or latency claim is made until dependencies are installed and comparable local hardware is available.

Run an upstream:

```sh
node examples/basic/upstreams.cjs
```

Run the gateway in another terminal:

```sh
node examples/basic/gateway.cjs
```

With `autocannon` installed separately:

```sh
npx autocannon -c 50 -d 30 -p 10 http://127.0.0.1:3000/api/users
npx autocannon -c 200 -d 30 -p 10 http://127.0.0.1:3000/api/users
```

Measure baseline direct-to-upstream, CPU, RSS, error rate and p50/p95/p99 latency, repeat each profile at least three times and report system information. Never compare HTTP/1.1 directly to h2c results without controlling the connection counts.
