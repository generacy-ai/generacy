# Contract: Scaffolder env + compose changes

**Modules**:
- `packages/generacy/src/cli/commands/cluster/scaffolder.ts` (shared scaffolder)
- `packages/generacy/src/cli/commands/launch/scaffolder.ts` (launch-specific wrapper)

**Issue**: [#716](https://github.com/generacy-ai/generacy/issues/716)

## `.generacy/.env` shape

`scaffoldEnvFile()` already writes `WORKER_COUNT=${workers}` (`scaffolder.ts:297`). No change to the line format. The value source changes from "hardcoded 1" to "user choice from `resolveWorkerCount`".

Existing template (relevant excerpt):

```text
# Project
PROJECT_NAME=…
REPO_URL=…
GENERACY_CHANNEL=preview
WORKER_COUNT=4
```

## `.generacy/docker-compose.yml` orchestrator service

`scaffoldDockerCompose()` adds one entry to the orchestrator service's `environment:` array. This is the **single material change** to the compose file shape.

### Before

```ts
const compose = {
  services: {
    orchestrator: {
      // …
      environment: [
        'REDIS_URL=redis://redis:6379',
        'REDIS_HOST=redis',
        `DEPLOYMENT_MODE=${deploymentMode}`,
        `CLUSTER_VARIANT=${variant}`,
      ],
      // …
    },
    worker: {
      // …
      deploy: { replicas: '${WORKER_COUNT:-1}' },
      // unchanged
    },
  },
};
```

### After

```ts
const compose = {
  services: {
    orchestrator: {
      // …
      environment: [
        'REDIS_URL=redis://redis:6379',
        'REDIS_HOST=redis',
        `DEPLOYMENT_MODE=${deploymentMode}`,
        `CLUSTER_VARIANT=${variant}`,
        'GENERACY_INITIAL_WORKERS=${WORKER_COUNT}',   // NEW
      ],
      // …
    },
    worker: {
      // unchanged
    },
  },
};
```

**Why `${WORKER_COUNT}` and not the literal value**: Compose interpolates `${WORKER_COUNT}` from the `.env` file at every `docker compose up`. This means:

1. The CLI writes the value once into `.env` at scaffold time.
2. The compose file references the env var symbolically — no second copy of the value.
3. Later mutations of `.env` (e.g., scale operations done outside the cluster) propagate to the orchestrator container's environment on next compose up.
4. The orchestrator's entrypoint reads `GENERACY_INITIAL_WORKERS` from its process environment and uses it (only) to seed `cluster.local.yaml` on first boot.

If we wrote the literal value here, future scale-from-host operations would have to keep the compose file and `.env` in sync — that's two mutation sites for one logical value, exactly the kind of drift we're trying to eliminate.

## Launch wrapper

`packages/generacy/src/cli/commands/launch/scaffolder.ts:73,88,102` — drop the hardcoded `workers: 1` in all three sites and thread the resolved value through:

```ts
export function scaffoldProject(
  projectDir: string,
  config: LaunchConfig,
  workers: number,     // NEW — required parameter; caller computes via resolveWorkerCount
): void {
  // …
  scaffoldClusterYaml(generacyDir, {
    channel: config.channel ?? 'preview',
    workers,            // was: 1
    variant: config.variant as 'cluster-base' | 'cluster-microservices',
  });

  scaffoldDockerCompose(generacyDir, {
    // …
    workers,            // was: 1
    // …
  });

  scaffoldEnvFile(generacyDir, {
    // …
    workers,            // was: 1
    // …
  });
}
```

**Note**: `cluster.yaml` continues to carry `workers: <chosen value>` until the cloud companion (#696) stops rendering it. After the companion lands, `scaffoldClusterYaml` should also drop the `workers` field — but that's a follow-up, not in scope for this issue. The local-wins semantics already established by #709 mean `cluster.local.yaml` (seeded by the entrypoint companion) overrides whatever `cluster.yaml` says.

## Tests

### `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` (extend)

```ts
describe('scaffoldDockerCompose', () => {
  it('includes GENERACY_INITIAL_WORKERS in orchestrator environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-'));
    scaffoldDockerCompose(dir, {
      imageTag: 'ghcr.io/generacy-ai/cluster-base:dev',
      clusterId: 'c1',
      projectId: 'p1',
      projectName: 'demo',
      cloudUrl: 'https://cloud',
      variant: 'cluster-base',
      orgId: 'o1',
      workers: 4,
    });
    const content = readFileSync(join(dir, 'docker-compose.yml'), 'utf-8');
    expect(content).toContain('GENERACY_INITIAL_WORKERS=${WORKER_COUNT}');
  });
});

describe('scaffoldEnvFile', () => {
  it('writes WORKER_COUNT from input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-'));
    scaffoldEnvFile(dir, {
      clusterId: 'c1', projectId: 'p1', orgId: 'o1', cloudUrl: 'https://cloud',
      projectName: 'demo', workers: 4,
    });
    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(content).toContain('WORKER_COUNT=4');
  });
});
```

## Acceptance criteria mapping

| Spec criterion | Site that satisfies it |
|---------------|------------------------|
| ".env (`WORKER_COUNT=N`)" | `scaffoldEnvFile` |
| "passed to orchestrator container (`GENERACY_INITIAL_WORKERS=N`)" | `scaffoldDockerCompose` |
| "cluster.local.yaml on first boot" | Companion `cluster-base` entrypoint PR (out of repo) |
| "metadata reports right worker count regardless of source" | Existing `readMergedClusterConfig` / `worker-count-deriver` |
