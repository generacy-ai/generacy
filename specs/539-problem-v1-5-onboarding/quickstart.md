# Quickstart: Testing Concurrent Local Clusters

## Prerequisites

- Node >= 22
- Docker Desktop or Docker Engine with Compose v2
- pnpm installed

## Build

```bash
pnpm install
pnpm -C packages/generacy build
```

## Run Tests

```bash
# Unit tests for the scaffolder
pnpm -C packages/generacy test -- --run src/cli/commands/cluster/__tests__/scaffolder.test.ts

# All CLI tests
pnpm -C packages/generacy test
```

## Manual Verification

### 1. Verify scaffolder output

Create a temp scaffold and inspect the compose file:

```bash
node -e "
  const { scaffoldDockerCompose } = require('./packages/generacy/dist/cli/commands/cluster/scaffolder.js');
  const { mkdtempSync } = require('fs');
  const { tmpdir } = require('os');
  const { join } = require('path');
  const dir = mkdtempSync(join(tmpdir(), 'test-'));
  scaffoldDockerCompose(dir, {
    imageTag: 'ghcr.io/generacy-ai/cluster-base:preview',
    clusterId: 'test-123', projectId: 'proj-1',
    projectName: 'test-project', cloudUrl: 'https://api.generacy.ai',
    variant: 'cluster-base'
  });
  console.log(require('fs').readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'));
"
```

Expected: `ports: ["3100"]` (ephemeral, no host binding). No 3101 or 3102.

### 2. Verify concurrent clusters

```bash
# Launch two clusters into different project directories
npx generacy launch --claim=<code1> --dir ~/Generacy/project-a
npx generacy launch --claim=<code2> --dir ~/Generacy/project-b

# Both should start without port conflicts
generacy status
```

Expected: Both clusters show "running" with different host ports for 3100.

### 3. Verify legacy warning

If you have an existing cluster with hardcoded ports:

```bash
cd ~/Generacy/existing-project
generacy up
```

Expected: Warning message about hardcoded port bindings with migration instructions.

### 4. Verify status port display

```bash
generacy status
```

Expected output includes a "Port" column:
```
Name     | Cluster ID | State   | Port  | Variant      | Channel | Path
project-a | clust_abc  | running | 49201 | cluster-base | stable  | /home/user/Generacy/project-a
project-b | clust_def  | running | 49202 | cluster-base | stable  | /home/user/Generacy/project-b
```

```bash
generacy status --json
```

Expected: Each entry includes `"hostPort": 49201`.

## Troubleshooting

- **Port conflicts on existing clusters**: Delete `.generacy/docker-compose.yml` and re-run `generacy launch`
- **Status shows no port**: Cluster may not be running; check `docker compose ps` directly
- **Deploy command still uses fixed ports**: This is intentional — remote VMs use `3100:3100`
