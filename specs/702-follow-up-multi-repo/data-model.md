# Data Model: Wire siblingFanoutHandler and complete agent prompt

No new types are introduced. This feature wires existing types together.

## Existing Types (read-only reference)

### SiblingFanoutContext (workflow-engine)

```typescript
// packages/workflow-engine/src/handlers/sibling-fanout.ts:17-36
interface SiblingFanoutContext {
  primaryWorkdir: string;
  siblingWorkdirs: Record<string, string>;
  issueNumber: number;
  primaryRepoName: string;
  org: string;
  workflowStore: WorkflowStore;
  workflowState: WorkflowState;
  logger: Logger;
  tokenProvider?: () => Promise<string | undefined>;
}
```

### PhaseAfterContext (orchestrator)

```typescript
// packages/orchestrator/src/worker/types.ts:288-299
interface PhaseAfterContext extends WorkerContext {
  phase: WorkflowPhase;
  commitResult: CommitResult;
}

interface CommitResult {
  prUrl?: string;
  hasChanges: boolean;
}

type PhaseAfterHandler = (context: PhaseAfterContext) => Promise<void>;
```

### SiblingFanoutResult (workflow-engine)

```typescript
// packages/workflow-engine/src/handlers/sibling-fanout.ts:41-62
interface SiblingOutcome {
  repo: string;
  branch: string;
  prNumber: number;
  prUrl: string;
  prCreated: boolean;
}

interface SiblingFanoutResult {
  processed: SiblingOutcome[];
  skipped: string[];
}
```

## Field Mapping

```
PhaseAfterContext              →  SiblingFanoutContext
──────────────────────────────────────────────────────
context.checkoutPath           →  primaryWorkdir
context.siblingWorkdirs        →  siblingWorkdirs
context.item.issueNumber       →  issueNumber
context.item.repo              →  primaryRepoName
context.item.owner             →  org
FilesystemWorkflowStore(path)  →  workflowStore
store.loadState(workflowId)    →  workflowState
context.logger                 →  logger
tokenProvider (closure)        →  tokenProvider
```

## State Flow

```
Phase completes
  → commitPushAndEnsurePr()
    → phaseAfterHandlers[0]: siblingFanoutHandler
      → detects sibling changes
      → commits, pushes, opens draft PRs
      → persists linkedPRs to workflow state JSON
    → phaseAfterHandlers[1]: linkedPRs reader
      → reads workflow state JSON
      → populates context.linkedPRs
  → gate check
    → on-sibling-review evaluates context.linkedPRs
```
