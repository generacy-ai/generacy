# Data Model: #889

## New Types

### `TerminalLabelOpError` (`packages/orchestrator/src/worker/terminal-label-op-error.ts`)

Typed `Error` subclass thrown by `LabelManager.retryWithBackoff` on final-attempt exhaustion.

```ts
export type TerminalLabelOpSite =
  | 'gate-hit'
  | 'phase-start'
  | 'phase-complete'
  | 'error'
  | 'resume-start'
  | 'workflow-complete';

export class TerminalLabelOpError extends Error {
  readonly site: TerminalLabelOpSite;
  readonly labelOp: string;      // e.g. "addLabels([waiting-for:merge-conflicts, agent:paused])"
  readonly ghStderr: string;     // verbatim stderr from the failing `gh` invocation
  readonly cause?: unknown;      // the original Error, preserved for logging

  constructor(args: {
    site: TerminalLabelOpSite;
    labelOp: string;
    ghStderr: string;
    cause?: unknown;
  });
}

export function isTerminalLabelOpError(e: unknown): e is TerminalLabelOpError;
```

**Validation rules**:

- `site` must be one of the six enumerated values (TypeScript-enforced).
- `labelOp` is a human-readable descriptor, not machine-parsed — used for the alert body.
- `ghStderr` is passed through to the `<details><summary>stderr…` block in the FR-004 alert body verbatim (subject to the existing backtick-neutralization in `stage-comment-manager.renderFailureAlert`).
- `cause` is retained for structured logging only; it is not surfaced to the user.

**Relationships**:

- Constructed inside `LabelManager.retryWithBackoff` when the caller passes `{ site, labelOp }` context (currently unused parameters that this change adds).
- Caught inside `phase-loop.ts` and `claude-cli-worker.ts` via `isTerminalLabelOpError(e)`.
- Its fields are copied into `WorkerResult.failureMetadata` on the `failed-terminal` branch.

### `WorkerResult` (`packages/orchestrator/src/worker/worker-result.ts`)

Discriminated union returned by `WorkerHandler`.

```ts
export type WorkerResult =
  | { readonly status: 'completed' }
  | {
      readonly status: 'failed-terminal';
      readonly failureMetadata: {
        readonly site: TerminalLabelOpSite;
        readonly labelOp: string;
        readonly ghStderr: string;
      };
    };
```

**Validation rules**:

- Zod schema not required — TypeScript's discriminated-union check at every `runWorker` branch is sufficient. No wire format; this crosses process boundaries only via the dispatcher.
- `failureMetadata` is required on the `failed-terminal` variant. The dispatcher consumes it directly for the alert emission.

**Relationships**:

- Returned by `ClaudeCliWorker.processItem` (the sole in-repo `WorkerHandler`).
- Consumed by `WorkerDispatcher.runWorker`. Branches: `'completed'` → `queue.complete(...)`; `'failed-terminal'` → best-effort recovery + alert emission + `queue.complete(...)`.
- Missing from the type set intentionally: `'released'` — release is the *default* behavior on unhandled throw, not an explicit return.

## Modified Types

### `WorkerHandler` (`packages/orchestrator/src/types/monitor.ts:260`)

**Before**:

```ts
export type WorkerHandler = (item: QueueItem) => Promise<void>;
```

**After**:

```ts
export type WorkerHandler = (item: QueueItem) => Promise<WorkerResult>;
```

Callers migrate by returning `{ status: 'completed' }` at happy-path exits and `{ status: 'failed-terminal', failureMetadata }` where a `TerminalLabelOpError` was caught. Non-label throws remain uncaught and propagate to the dispatcher's outer catch (which continues to call `queue.release(...)` — unchanged behavior).

### `PhaseLoopResult` (`packages/orchestrator/src/worker/types.ts` / `phase-loop.ts`)

Add a `status` discriminator alongside the existing `gateHit`/`completed` flags:

```ts
export type PhaseLoopStatus = 'completed' | 'gate-hit' | 'phase-failed' | 'failed-terminal';

export interface PhaseLoopResult {
  readonly results: PhaseResult[];
  readonly completed: boolean;
  readonly lastPhase: WorkflowPhase;
  readonly gateHit: boolean;
  readonly status: PhaseLoopStatus;
  readonly failureMetadata?: {
    site: TerminalLabelOpSite;
    labelOp: string;
    ghStderr: string;
  };
}
```

`failureMetadata` is populated only when `status === 'failed-terminal'`. Backwards-compatible with existing consumers that read only `completed`/`gateHit`/`lastPhase`.

### `FailureAlertData.stage` (`packages/orchestrator/src/worker/types.ts`)

Extend the existing union additively:

```ts
export type FailureAlertStage =
  | 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement' | 'validate'
  | 'label-op';  // NEW in #889
```

The `evidence` shape for `stage: 'label-op'` reuses the existing `{ command; exitDescriptor; stderrTail }` fields:

- `command` — `"gh issue edit --add-label <label>"` (or the equivalent verbose descriptor).
- `exitDescriptor` — `"exited 1"` (label-op failures are always non-zero exit).
- `stderrTail` — verbatim `TerminalLabelOpError.ghStderr`.

## Modified Data

### `WORKFLOW_LABELS` (`packages/workflow-engine/src/actions/github/label-definitions.ts:20-105`)

Add one entry to the `waiting-for:*` block:

```ts
{ name: 'waiting-for:merge-conflicts', color: 'FBCA04', description: 'Waiting for base-merge conflict resolution' },
```

Placement: after `waiting-for:dependencies` (line 42), preserving the `waiting-for:*` grouping. Color `FBCA04` matches every sibling `waiting-for:*` entry.

### `LabelManager` (`packages/orchestrator/src/worker/label-manager.ts`)

**New state**:

- `private static ensuredRepos = new Set<string>()` — shared across instances in the same process, keyed on `"owner/repo"`.
- `private static ensureInFlight = new Map<string, Promise<void>>()` — in-flight-Promise dedupe for concurrent first-callers.

**New method**:

```ts
private async ensureRepoLabelsExist(): Promise<void>;
```

- Returns immediately if `"${this.owner}/${this.repo}"` is in `LabelManager.ensuredRepos`.
- Otherwise checks `LabelManager.ensureInFlight` for an in-flight Promise; if present, awaits it.
- Otherwise creates a new Promise: calls `github.listLabels(this.owner, this.repo)`, computes the missing set against `WORKFLOW_LABELS`, calls `github.createLabel(...)` per miss (each wrapped in try/catch — a create-race with a sibling worker on the same repo logs a `warn` and continues).
- On completion (success or failure), populates `LabelManager.ensuredRepos` and removes from `LabelManager.ensureInFlight`.

**Call sites** (all inside `retryWithBackoff` callbacks):

- `onPhaseStart` — first statement inside the callback.
- `onPhaseComplete` — first statement.
- `onGateHit` — first statement.
- `onError` — first statement.
- `onResumeStart` — first statement.
- `onWorkflowComplete` — first statement.
- `ensureCleanup` — NOT called (this path already swallows all errors; the ensure-pass would add a network roundtrip in a hot path with no correctness benefit).

**Modified `retryWithBackoff` signature**:

```ts
private async retryWithBackoff<T>(
  fn: () => Promise<T>,
  context: { site: TerminalLabelOpSite; labelOp: string },
): Promise<T>;
```

- On final-attempt failure, throws `new TerminalLabelOpError({ site: context.site, labelOp: context.labelOp, ghStderr: extractStderr(error), cause: error })`.
- `extractStderr(error)`: returns `error.message` if it's an `Error`, `String(error)` otherwise; the underlying `gh-cli.ts` wraps stderr into the Error message already.

### `WorkerDispatcher.runWorker` (`packages/orchestrator/src/services/worker-dispatcher.ts:334-366`)

**Before** (pseudo):

```ts
try {
  await this.handler(item);
  await this.queue.complete(workerId, item);
} catch (error) {
  await this.queue.release(workerId, item);
}
```

**After** (pseudo):

```ts
try {
  const result = await this.handler(item);
  if (result.status === 'failed-terminal') {
    await this.emitTerminalFailureRecovery(item, result.failureMetadata);
    await this.queue.complete(workerId, item);
  } else {
    await this.queue.complete(workerId, item);
  }
} catch (error) {
  await this.queue.release(workerId, item);
}
```

**New method**: `private async emitTerminalFailureRecovery(item, failureMetadata): Promise<void>` — wraps three best-effort steps:

1. `agent:error` label add via a new `LabelManager` instance (constructed per-item — the standing worker-scoped one is not reachable here). Try/catch, `warn` on failure.
2. `stageCommentManager.postFailureAlert(...)` with `stage: 'label-op'`, fresh `runId`, `evidence` built from `failureMetadata`. Try/catch, `error` on failure (log includes `site`, `labelOp`, `ghStderr`, `alertError`).
3. Optionally `sseEmitter?.({ type: 'workflow:failed', ... })` for real-time cluster observability — this is defense in depth (the alert comment is the authoritative surface).

Injecting `stageCommentManager` and `github` into `WorkerDispatcher` is a small constructor extension — the existing `labelCleanup?: LabelCleanupFn` field is already a similar dependency. Alternatively, a `terminalFailureHandler?: (item, failureMetadata) => Promise<void>` callback lets the wiring live where `WorkerDispatcher` is constructed (e.g., `server.ts`), keeping the dispatcher's constructor lean. **Recommended**: callback pattern for testability.
