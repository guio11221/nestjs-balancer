---
name: add-strategy
description: Extend the route balancer with a load balancing selection strategy.
---
# Add a strategy

1. Extend the `BalancingStrategy` union in `src/types.ts`.
2. Extend allowed strategies in `src/options.ts` validation.
3. Implement a deterministic selection branch in `src/strategies/select.ts` where possible.
4. Only use healthy nodes; return `undefined` if none are available.
5. Add a unit test for distribution, empty set, and excluded unhealthy targets.
6. Explain the strategy and any probabilistic or fairness limitations in README.
7. Do not mutate active counters within selector; `RouteBalancerService.acquire` owns these counters.
