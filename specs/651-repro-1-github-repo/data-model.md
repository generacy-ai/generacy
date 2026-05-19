# Data Model: CLI scaffolder REPO_BRANCH fix

**Feature**: #651 | **Date**: 2026-05-19

## Core Interface

### ScaffoldEnvInput (unchanged)

```typescript
// packages/generacy/src/cli/commands/cluster/scaffolder.ts
export interface ScaffoldEnvInput {
  clusterId: string;
  projectId: string;
  orgId: string;
  cloudUrl: string;
  projectName: string;
  repoUrl?: string;
  repoBranch?: string;      // Optional — when undefined, REPO_BRANCH line omitted
  channel?: 'stable' | 'preview';
  workers?: number;
  orchestratorPort?: number;
  cloud?: { apiUrl: string; relayUrl: string };
}
```

The interface already models `repoBranch` as optional (`string | undefined`). No schema changes needed.

## Generated .env File Format

### Before (broken)

```env
# Project
PROJECT_NAME=my-project
REPO_URL=https://github.com/org/repo
REPO_BRANCH=main           # <-- always present, always 'main'
GENERACY_CHANNEL=preview
WORKER_COUNT=1
```

### After — no branch specified

```env
# Project
PROJECT_NAME=my-project
REPO_URL=https://github.com/org/repo
GENERACY_CHANNEL=preview
WORKER_COUNT=1
```

### After — explicit branch

```env
# Project
PROJECT_NAME=my-project
REPO_URL=https://github.com/org/repo
REPO_BRANCH=develop        # <-- only when explicitly provided
GENERACY_CHANNEL=preview
WORKER_COUNT=1
```

## Validation Rules

| Field | Type | Required | Validation |
|-------|------|----------|------------|
| `repoBranch` | `string \| undefined` | No | When present: non-empty string, written as-is. When absent: line omitted. |

## Downstream Consumer

`REPO_BRANCH` is read by `entrypoint-post-activation.sh` in cluster-base. The companion PR ensures:
- Set and non-empty → `git clone --branch $REPO_BRANCH`
- Unset or empty → `git clone` (uses repo HEAD)
