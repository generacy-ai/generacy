# Data Model: Inject sibling-repo awareness into agent prompt

**Feature**: #688 — Phase 1 multi-repo
**Date**: 2026-05-22

## Core Type Changes

### WorkerContext (modified)

**File**: `packages/orchestrator/src/worker/types.ts`

```typescript
export interface WorkerContext {
  workerId: string;
  jobId: string;
  item: QueueItem;
  startPhase: WorkflowPhase;
  github: GitHubClient;
  logger: Logger;
  signal: AbortSignal;
  checkoutPath: string;
  issueUrl: string;
  description: string;
  prUrl?: string;
  siblingWorkdirs?: string[];  // NEW — absolute paths to sibling repos
}
```

**Field**: `siblingWorkdirs`
- **Type**: `string[]` (optional)
- **Content**: Absolute filesystem paths to sibling repo directories (e.g., `['/workspaces/agency', '/workspaces/generacy-cloud']`)
- **Source**: Populated by `claude-cli-worker.ts` from workspace config (Issue A #687). Stubbed as `[]` in Phase 1
- **Consumer**: `phase-loop.ts` reads this to build the sibling prompt block
- **Lifecycle**: Immutable after context creation — set once, never updated

### buildSiblingPromptBlock (new function)

**File**: `packages/orchestrator/src/worker/sibling-prompt.ts`

```typescript
/**
 * Builds a markdown instruction block listing sibling repos.
 * Returns undefined when the list is empty (no block emitted).
 */
export function buildSiblingPromptBlock(workdirs: string[]): string | undefined;
```

**Input**: Array of absolute paths
**Output**: Formatted markdown string or `undefined`
**Format**:
```
**Sibling repos available in this workspace.** You may edit files in any of these as part of this task:
- `agency` — `/workspaces/agency`
- `generacy-cloud` — `/workspaces/generacy-cloud`
```

**Rules**:
- Empty array → returns `undefined` (not empty string)
- Repo name = `path.basename(dir)` (directory basename)
- Each entry: `` - `<basename>` — `<absolute-path>` ``
- Header line always the same (no variable parts)

## Data Flow

```
claude-cli-worker.ts          phase-loop.ts              cli-spawner.ts
┌──────────────────┐     ┌──────────────────────┐    ┌──────────────┐
│ context = {      │     │ siblingBlock =        │    │ spawnPhase({ │
│   ...            │     │   buildSiblingPrompt  │    │   prompt,    │
│   siblingWorkdirs│────▶│     Block(context     │───▶│   ...        │
│     : string[]   │     │     .siblingWorkdirs) │    │ })           │
│ }                │     │ prompt = block        │    └──────────────┘
└──────────────────┘     │   ? block + issueUrl  │
                         │   : issueUrl          │
                         └──────────────────────┘
```

## Validation Rules

| Field | Validation | Error Behavior |
|-------|-----------|----------------|
| `siblingWorkdirs` | Optional; if present, each entry must be a non-empty string | No runtime validation in Phase 1 (trusted internal data) |
| `buildSiblingPromptBlock` input | Empty array check | Returns `undefined` — no error |
| Prompt output | Must be non-empty string | Always true: falls back to `context.issueUrl` |

## No Schema Changes

- No Zod schemas modified (siblingWorkdirs is internal context, not config or API input)
- No API contracts affected
- No persistence layer touched
- `CliSpawnOptions` interface unchanged (prompt is already `string`)
