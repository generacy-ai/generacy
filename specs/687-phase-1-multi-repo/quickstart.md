# Quickstart: Phase 1 Multi-Repo Workflow Support

## Overview

This change adds `siblingWorkdirs: Record<string, string>` to the workflow engine's `ActionContext` and `ExecutionOptions`, populated from `workspace.repos` in `.generacy/config.yaml`. No existing behavior changes — this is plumbing for Phase 2.

## Setup

```bash
pnpm install
pnpm -r build
```

## How It Works

### 1. Workspace Config

The sibling map is derived from `.generacy/config.yaml`:

```yaml
workspace:
  org: generacy-ai
  branch: develop
  repos:
    - name: tetrad-development
      monitor: true
    - name: generacy
      monitor: true
    - name: generacy-cloud
      monitor: true
```

### 2. Resolution

When the orchestrator processes a workflow for `tetrad-development`:

```typescript
import { resolveSiblingWorkdirs } from '@generacy-ai/config';

const config = tryLoadWorkspaceConfig(configPath);
const siblings = resolveSiblingWorkdirs(config, '/workspaces/tetrad-development');
// → { "generacy": "/workspaces/generacy", "generacy-cloud": "/workspaces/generacy-cloud" }
```

### 3. Access in Action Handlers

Action handlers receive the sibling map via `ActionContext`:

```typescript
// In a future Phase 2 action handler:
async function execute(context: ActionContext): Promise<StepOutput> {
  const { workdir, siblingWorkdirs } = context;
  // workdir = "/workspaces/tetrad-development"
  // siblingWorkdirs = { "generacy": "/workspaces/generacy", ... }
}
```

## Testing

```bash
# Run config package tests (includes resolveSiblingWorkdirs)
cd packages/config && pnpm test

# Run workflow-engine tests (includes sibling threading)
cd packages/workflow-engine && pnpm test

# Run all tests
pnpm -r test
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `siblingWorkdirs` is `{}` | No `.generacy/config.yaml` found | Expected for single-repo workspaces |
| `siblingWorkdirs` is `{}` with warning log | Primary workdir doesn't match any repo in config | Check that the repo name in config matches the directory name |
| Sibling repo missing from map | Directory doesn't exist on disk | Clone the repo to the expected peer path |
| Build error on `ActionContext.siblingWorkdirs` | Stale type cache | Run `pnpm -r build` to regenerate declarations |
