# Data Model: Label Sync Utility

## Core Entities

### LabelDefinition

Canonical definition of a workflow label. Shared across packages.

```typescript
interface LabelDefinition {
  name: string;        // e.g., "phase:specify"
  color: string;       // 6-char hex without #, e.g., "0052CC"
  description: string; // Human-readable purpose
}
```

### RepositoryConfig

A watched repository entry in orchestrator configuration.

```typescript
interface RepositoryConfig {
  owner: string;  // GitHub org or user, e.g., "generacy-ai"
  repo: string;   // Repository name, e.g., "generacy"
}
```

### LabelSyncResult

Result of syncing a single label on a single repo.

```typescript
interface LabelSyncResult {
  name: string;
  action: 'created' | 'updated' | 'unchanged';
}
```

### RepoSyncResult

Aggregated result for one repository.

```typescript
interface RepoSyncResult {
  owner: string;
  repo: string;
  success: boolean;
  created: number;
  updated: number;
  unchanged: number;
  error?: string;
  results: LabelSyncResult[];
}
```

### SyncAllResult

Top-level result from syncing all watched repos.

```typescript
interface SyncAllResult {
  totalRepos: number;
  successfulRepos: number;
  failedRepos: number;
  results: RepoSyncResult[];
}
```

## Configuration Schema (Zod)

```typescript
const RepositoryConfigSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
});

// Added to OrchestratorConfigSchema
const OrchestratorConfigSchema = z.object({
  // ... existing fields
  repositories: z.array(RepositoryConfigSchema).default([]),
});
```

## Label Categories

| Category | Pattern | Color | Count |
|----------|---------|-------|-------|
| Process triggers | `process:*` | `D876E3` | 2 |
| Phase | `phase:*` | `0052CC` | 6 |
| Completed | `completed:*` | `0E8A16` | 13 |
| Waiting-for | `waiting-for:*` | `FBCA04` | 10 |
| Agent | `agent:*` | `0366D6`/`C5DEF5`/`F9D0C4` | 3 |
| Type | `type:*` | varies | 3 |
| Needs | `needs:*` | `D93F0B` | 2 |
| Utility | misc | `bfd4f2` | 1 |

## Relationships

```
OrchestratorConfig
  └── repositories: RepositoryConfig[]

LabelSyncService
  ├── uses: LabelDefinition[] (from WORKFLOW_LABELS)
  ├── uses: GitHubClient (from workflow-engine)
  └── produces: SyncAllResult
        └── results: RepoSyncResult[]
              └── results: LabelSyncResult[]
```
