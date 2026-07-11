# Contract: `GENERACY_CLUSTER_ROLE` scaffolder env var (Q2-A)

## Files affected in this PR

**`packages/generacy/src/cli/commands/cluster/scaffolder.ts`**

Two additions to `scaffoldDockerCompose()`, in the two service `environment` arrays:

```ts
// orchestrator service (~line 213 today)
environment: [
  'REDIS_URL=redis://redis:6379',
  'REDIS_HOST=redis',
  `DEPLOYMENT_MODE=${deploymentMode}`,
  `CLUSTER_VARIANT=${variant}`,
  'GENERACY_INITIAL_WORKERS=${WORKER_COUNT}',
  'GENERACY_CLUSTER_ROLE=orchestrator',   // NEW
],
```

```ts
// worker service (~line 244 today)
environment: [
  'REDIS_URL=redis://redis:6379',
  'REDIS_HOST=redis',
  'HEALTH_PORT=9001',
  `DEPLOYMENT_MODE=${deploymentMode}`,
  `CLUSTER_VARIANT=${variant}`,
  'GENERACY_CLUSTER_ROLE=worker',         // NEW
],
```

## Values

- `orchestrator` — on the orchestrator service, in every code path that generates the compose file (local launch, deploy-ssh scaffolder).
- `worker` — on the worker service, same code paths.

Values are literal strings. No env-var interpolation. Case-sensitive (lowercase).

## Consumers

Currently one consumer: `cockpit mcp` refuses to start when `process.env.GENERACY_CLUSTER_ROLE === 'worker'`.

Future consumers may inspect this value to gate role-specific behavior (worker log verbosity, feature flags). The value set is closed: `orchestrator` | `worker`. Any other value or absence means the code path is running outside a scaffolded cluster (dev laptop, local tests, cloud-deploy in a drift state) — treat as neither role for gating purposes (fail open on defense-in-depth checks; primary control must always be in place).

## Drift hazard (Q2-A documented)

The scaffolder in this repo generates local-launch compose files. Cloud-deploy compose generation lives in a separate repo (`generacy-ai/generacy-cloud` — `packages/cloud-deploy/`) and has historically diverged from this scaffolder in silent ways (see the audit trail in scaffolder git log).

**Companion issue** (cloud-deploy side, tracked separately — TBD number): add `GENERACY_CLUSTER_ROLE=orchestrator` and `GENERACY_CLUSTER_ROLE=worker` to the corresponding service `environment` arrays in cloud-deploy's compose generation. Must ship in the same release train as this PR.

If cloud-deploy misses the change, deployed clusters run with `GENERACY_CLUSTER_ROLE=undefined` on both services. Safe-direction drift for the current consumer:

- `cockpit mcp` refuses on `=== 'worker'` — under-refuses under `undefined` (starts normally on worker containers if they ever try to run it). Primary control (worker entrypoints not registering the server) still prevents the server from being spawned at all.

## Test coverage

New test file: `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder-cluster-role-env.test.ts`.

Assertions:

1. `scaffoldDockerCompose()` output contains `GENERACY_CLUSTER_ROLE=orchestrator` in the orchestrator service's `environment` array.
2. `scaffoldDockerCompose()` output contains `GENERACY_CLUSTER_ROLE=worker` in the worker service's `environment` array.
3. Both assertions live in the same test — the pair is the invariant. A failure to write one but not the other is not a valid state.

## Regression test at the consumer

`packages/generacy/src/cli/commands/cockpit/mcp/__tests__/server-refuses-worker-role.test.ts` asserts:

1. Set `process.env.GENERACY_CLUSTER_ROLE = 'worker'`.
2. Invoke `cockpitMcpCommand()` action handler.
3. Assert `process.exit` was called with non-zero code.
4. Assert stderr received the role-refusal message (substring match on `GENERACY_CLUSTER_ROLE=worker`).

5. Set `process.env.GENERACY_CLUSTER_ROLE = 'orchestrator'`.
6. Invoke `cockpitMcpCommand()` action handler under a mocked stdio transport.
7. Assert no exit; server enters its wait loop.

Absence of the env var (undefined) is not tested — it's neither a supported production case nor a failure case; fail-open is the intended posture on undefined values.
