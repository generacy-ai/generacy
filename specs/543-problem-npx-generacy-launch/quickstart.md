# Quickstart: Fix launch CLI scaffolder (#543)

## Overview

This fix rewrites the Docker Compose scaffolder so that `npx generacy launch` produces a working multi-service cluster (orchestrator + worker + redis) instead of a single-service compose that crash-loops.

## What changes

1. **`packages/generacy/src/cli/commands/cluster/scaffolder.ts`** — Core changes:
   - `scaffoldDockerCompose()` now emits 3 services (orchestrator, worker, redis) with healthchecks, depends_on, tmpfs, correct volumes
   - New `scaffoldEnvFile()` generates `.generacy/.env` with cloud-provided values
   - New `deriveRelayUrl()` converts HTTP cloud URL to wss relay URL
   - `ScaffoldComposeInput` gains `orgId`, `workers`, `channel`, `repoUrl`, `claudeConfigMode` fields

2. **`packages/generacy/src/cli/commands/launch/scaffolder.ts`** — Launch-specific:
   - Calls `scaffoldEnvFile()` during project scaffolding
   - New `preCreateClaudeJson()` creates `~/.claude.json` if missing (prevents bind-mount failure)

3. **`packages/generacy/src/cli/commands/deploy/scaffolder.ts`** — Deploy-specific:
   - Passes `claudeConfigMode: 'volume'` (no bind mount on remote)
   - Passes additional fields to shared scaffolder

4. **Tests** — Updated to verify multi-service compose structure

## Development

```bash
# Install dependencies
pnpm install

# Run the affected tests
pnpm --filter @generacy-ai/generacy test -- --grep scaffolder

# Run all CLI tests
pnpm --filter @generacy-ai/generacy test

# Build the CLI package
pnpm --filter @generacy-ai/generacy build
```

## Manual verification

```bash
# On staging with a fresh claim code:
npx -y @generacy-ai/generacy@preview launch --claim=<code>

# Inspect the generated files:
cat ~/Generacy/<project>/.generacy/docker-compose.yml
cat ~/Generacy/<project>/.generacy/.env

# Verify 3 containers are running:
docker compose -f ~/Generacy/<project>/.generacy/docker-compose.yml ps

# Expected: orchestrator (healthy), worker (healthy), redis (healthy)
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Container exits with code 0 in <1s | Old single-service compose (no `command:` override) | Re-run `launch` with fixed CLI version |
| Orchestrator hangs at boot | Redis service missing or unhealthy | Check `docker compose logs redis` |
| Bind mount error for `.claude.json` | File doesn't exist on host | `touch ~/.claude.json` or re-run launch (auto-creates) |
| `GENERACY_CLOUD_URL` wrong format | HTTP URL instead of wss relay URL | Rebuild with `deriveRelayUrl()` fix |
| Worker not starting | `depends_on` waiting for orchestrator health | Check orchestrator healthcheck: `curl http://localhost:3100/health` |

## Key files

```
packages/generacy/src/cli/commands/
├── cluster/
│   ├── scaffolder.ts        # Shared compose + .env generation
│   └── __tests__/scaffolder.test.ts
├── launch/
│   ├── scaffolder.ts        # Launch-specific scaffolding
│   ├── index.ts             # Launch command entry point
│   └── __tests__/scaffolder.test.ts
└── deploy/
    └── scaffolder.ts        # Deploy-specific scaffolding
```
