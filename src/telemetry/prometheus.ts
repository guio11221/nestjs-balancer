import type { BalancerMetrics, UpstreamState } from '../types';

function safeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

interface MetricDefinition {
  key: keyof UpstreamState;
  name: string;
  type: 'counter' | 'gauge';
  help: string;
}

const METRICS: MetricDefinition[] = [
  { key: 'healthy', name: 'route_balancer_upstream_healthy', type: 'gauge', help: 'Whether the upstream is currently considered healthy (1) or open-circuit (0).' },
  { key: 'weight', name: 'route_balancer_upstream_weight', type: 'gauge', help: 'Configured balancing weight for the upstream.' },
  { key: 'active', name: 'route_balancer_upstream_active_connections', type: 'gauge', help: 'Requests currently in flight to the upstream.' },
  { key: 'requests', name: 'route_balancer_upstream_requests_total', type: 'counter', help: 'Requests dispatched to the upstream.' },
  { key: 'errors', name: 'route_balancer_upstream_errors_total', type: 'counter', help: 'Request transport failures attributed to the upstream.' },
  { key: 'successes', name: 'route_balancer_upstream_successes_total', type: 'counter', help: 'Requests completed successfully by the upstream.' },
  { key: 'healthCheckSuccesses', name: 'route_balancer_upstream_health_check_successes_total', type: 'counter', help: 'Successful active health probes for the upstream.' },
  { key: 'healthCheckFailures', name: 'route_balancer_upstream_health_check_failures_total', type: 'counter', help: 'Failed active health probes for the upstream.' },
  { key: 'consecutiveFailures', name: 'route_balancer_upstream_consecutive_failures', type: 'gauge', help: 'Consecutive transport or health-check failures for the upstream.' },
];

/** Prometheus exposition text, without a runtime dependency on a metrics SDK. */
export function prometheusMetrics(metrics: BalancerMetrics): string {
  const lines: string[] = [];
  for (const metric of METRICS) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);
    for (const route of metrics.routes) {
      for (const node of route.upstreams) {
        const value = node[metric.key];
        const numeric = typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'number' ? value : 0;
        lines.push(`${metric.name}{route="${safeLabel(route.path)}",upstream="${safeLabel(node.url)}"} ${numeric}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
