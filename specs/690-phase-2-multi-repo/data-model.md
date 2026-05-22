# Data Model: Generic `phase:after` Extension Hook

## Core Types

### PhaseAfterContext

The context passed to each `phase:after` handler. Combines the full `WorkerContext` with phase-specific information.

```typescript
/**
 * Context provided to phase:after handlers.
 * Includes the full WorkerContext (workdir, config, item, signal, prUrl, etc.)
 * plus the completed phase name and its commit result.
 */
export interface PhaseAfterContext extends WorkerContext {
  /** The phase that just completed */
  phase: WorkflowPhase;
  /** Result from commitPushAndEnsurePr() for this phase */
  commitResult: CommitResult;
}
```

### CommitResult

The result of `commitPushAndEnsurePr()`, already returned by `PrManager` but not yet a named type.

```typescript
export interface CommitResult {
  /** PR URL if one was created or already exists */
  prUrl?: string;
  /** Whether the phase produced any git changes */
  hasChanges: boolean;
}
```

### PhaseAfterHandler

The handler function signature.

```typescript
/**
 * Async function that runs after a phase completes (post-commit, pre-gate).
 * Throwing stops subsequent handlers (fail-fast) and blocks the phase.
 */
export type PhaseAfterHandler = (context: PhaseAfterContext) => Promise<void>;
```

### PhaseLoopDeps (modified)

```typescript
export interface PhaseLoopDeps {
  labelManager: LabelManager;
  stageCommentManager: StageCommentManager;
  gateChecker: GateChecker;
  cliSpawner: CliSpawner;
  outputCapture: OutputCapture;
  prManager: PrManager;
  conversationLogger?: ConversationLogger;
  jobEventEmitter?: JobEventEmitter;
  /** Optional callbacks invoked after each phase completes, before gate check */
  phaseAfterHandlers?: PhaseAfterHandler[];  // NEW
}
```

## Type Relationships

```
WorkerContext (existing)
├── workdir: string
├── config: WorkspaceConfig
├── item: WorkItem
├── signal: AbortSignal
├── prUrl?: string
├── siblingWorkdirs: Record<string, string>
├── githubClient: GitHubClient
└── logger: Logger

PhaseAfterContext (new)
├── ...WorkerContext (all fields)
├── phase: WorkflowPhase
└── commitResult: CommitResult

CommitResult (new, named type for existing return shape)
├── prUrl?: string
└── hasChanges: boolean

PhaseLoopDeps (modified)
├── ...existing deps
└── phaseAfterHandlers?: PhaseAfterHandler[]  (NEW)
```

## Validation Rules

- `phaseAfterHandlers` is optional; defaults to `[]` when not provided
- Handlers execute in array order (registration order)
- Handler must not return a value (return type is `Promise<void>`)
- Handler throwing any error triggers fail-fast; the error propagates to the phase loop's existing error handling
