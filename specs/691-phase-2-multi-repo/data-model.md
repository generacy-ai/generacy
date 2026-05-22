# Data Model: Phase 2 Multi-Repo — Cross-Repo Change Fan-Out

## Modified Types

### GitStatus (extended)

**File**: `packages/workflow-engine/src/actions/github/client/interface.ts`

```typescript
export interface GitStatus {
  branch: string;
  has_changes: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  /** True when local HEAD is ahead of origin/<branch> */
  hasUnpushed: boolean;
  /** Number of commits ahead of origin/<branch>. 0 if no remote tracking branch. */
  unpushedCount: number;
}
```

**Migration**: Additive change. All existing callers receive the new fields but don't need to use them. No breaking change.

## Existing Types (used as-is from #689)

### LinkedPR

**File**: `packages/workflow-engine/src/types/store.ts:23-32`

```typescript
export interface LinkedPR {
  repo: string;      // e.g. "generacy-cloud"
  number: number;    // PR number in sibling repo
  branch: string;    // Branch the PR was opened from
  url: string;       // Full URL to the PR
}
```

### WorkflowState.linkedPRs

**File**: `packages/workflow-engine/src/types/store.ts:67`

```typescript
linkedPRs?: LinkedPR[];
```

## New Types

### SiblingFanoutContext

**File**: `packages/workflow-engine/src/handlers/sibling-fanout.ts`

```typescript
export interface SiblingFanoutContext {
  /** Absolute path to the primary repository working directory */
  primaryWorkdir: string;
  /** Map of sibling repo name → absolute path */
  siblingWorkdirs: Record<string, string>;
  /** Issue number from the phase-loop context */
  issueNumber: number;
  /** Primary repo short name (e.g. "generacy") */
  primaryRepoName: string;
  /** GitHub org (e.g. "generacy-ai") */
  org: string;
  /** Workflow store for persisting linkedPRs */
  workflowStore: WorkflowStore;
  /** Current workflow state (read for linkedPRs, written back after updates) */
  workflowState: WorkflowState;
  /** Logger instance */
  logger: Logger;
  /** Optional GitHub token provider (follows #620 pattern) */
  tokenProvider?: () => Promise<string | undefined>;
}
```

### SiblingFanoutResult

```typescript
export interface SiblingFanoutResult {
  /** Siblings that were processed (had changes) */
  processed: SiblingOutcome[];
  /** Siblings that were skipped (no changes) */
  skipped: string[];
}

export interface SiblingOutcome {
  /** Sibling repo name */
  repo: string;
  /** Branch name used */
  branch: string;
  /** PR number (newly created or existing) */
  prNumber: number;
  /** Full PR URL */
  prUrl: string;
  /** Whether the PR was newly created or already existed */
  prCreated: boolean;
}
```

## Relationships

```
WorkflowState
  └── linkedPRs: LinkedPR[]     (persisted via addLinkedPR helper)

ActionContext
  └── siblingWorkdirs: Record<string, string>  (from Phase 1 #687)

SiblingFanoutContext
  ├── references → WorkflowState (for linkedPRs persistence)
  ├── references → siblingWorkdirs (from ActionContext)
  └── uses → GitHubClient (one per sibling workdir)

GitStatus
  ├── has_changes: boolean       (existing — working tree dirty)
  ├── hasUnpushed: boolean       (NEW — commits ahead of remote)
  └── unpushedCount: number      (NEW — count of unpushed commits)
```

## Validation Rules

1. **siblingWorkdirs values**: Must be absolute paths to existing directories (validated by `resolveSiblingWorkdirs` in Phase 1)
2. **issueNumber**: Must be positive integer (sourced from phase-loop context, not user input)
3. **org**: Must be non-empty string (from workspace config `workspace.org`)
4. **primaryRepoName**: Must match a repo in workspace config (path-match validated)
5. **LinkedPR.repo + LinkedPR.number**: Composite uniqueness key for de-duplication in `addLinkedPR`
