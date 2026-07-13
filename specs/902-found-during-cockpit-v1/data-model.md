# Data Model: `#902` MergeConflictHandler success-path re-arm

Companion to `plan.md` and `research.md`. Enumerates the types, entities, and relationships introduced or modified by this ship.

## New types

### `HandlerOutcome` (FR-005)

**Location**: `packages/orchestrator/src/worker/handler-outcome.ts` (NEW file).

Discriminated union covering every legal handler terminal outcome:

```typescript
import type { WorkflowPhase } from './types.js';
import type { QueueItem } from '../types/index.js';
import type { BlockedStuckMergeConflictsEvidence } from './merge-conflict-handler.js';

export type HandlerOutcome =
  | ReArmedOutcome
  | GatedOutcome
  | FailedOutcome
  | DoneOutcome;

export interface ReArmedOutcome {
  readonly outcome: 're-armed';
  /** Phase the interrupted worker should resume at. Threaded to enqueue. */
  readonly startPhase: WorkflowPhase;
}

export interface GatedOutcome {
  readonly outcome: 'gated';
  /**
   * The `waiting-for:*` label that MUST be present on the issue at return.
   * Enforced by assertHandlerOutcomeMatchesWorld.
   */
  readonly gateLabel: string;
}

export interface FailedOutcome {
  readonly outcome: 'failed';
  /**
   * Evidence blob rendered into the operator-facing stage comment.
   * Shape is handler-specific; MergeConflictHandler uses
   * BlockedStuckMergeConflictsEvidence.
   */
  readonly evidence: BlockedStuckMergeConflictsEvidence;
}

export interface DoneOutcome {
  readonly outcome: 'done';
}
```

**Invariants**:

- Exactly one variant per handler exit path. Exhaustiveness enforced by TypeScript.
- The load-bearing enforcement is the runtime helper below, not the type.

### `assertHandlerOutcomeMatchesWorld` (FR-006)

**Location**: `packages/orchestrator/src/worker/handler-outcome-assertion.ts` (NEW file).

Pure-function post-exit assertion that reads a snapshot of the *real* world (labels + queue state) and refuses to accept "the handler said X":

```typescript
export interface QueueSnapshot {
  readonly inFlight: boolean;
  readonly pendingItems: readonly Pick<QueueItem, 'command' | 'metadata' | 'workflowName'>[];
}

export type AssertionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly mismatch: string };

export function assertHandlerOutcomeMatchesWorld(
  outcome: HandlerOutcome,
  labels: readonly string[],
  queueSnapshot: QueueSnapshot,
): AssertionResult;
```

**Rules per variant**:

| Outcome | Assertion |
|---------|-----------|
| `re-armed` | `queueSnapshot.pendingItems` contains an item with `command === 'continue'` and `metadata?.startPhase === outcome.startPhase`. |
| `gated` | `labels` contains a `waiting-for:*` matching `outcome.gateLabel`. |
| `failed` | `labels` contains a `blocked:*` or `failed:*` marker. |
| `done` | `labels` contains no `waiting-for:*` and no `blocked:*` / `failed:*`. |

**Return**: `{ok: true}` on match; `{ok: false, mismatch}` with a human-readable description of the divergence on mismatch. Fixtures fail the test on `ok: false`.

**Rationale for pure-function shape**: fixture code snapshots the world, then calls the helper. Doesn't need github/queue clients directly — tests supply the snapshot. Same helper is callable from prod code as a dev-mode assertion (not enabled by default).

## Modified types

### `ResolveMergeConflictsMetadata` (FR-003)

**Location**: `packages/orchestrator/src/types/monitor.ts` (MODIFIED).

```typescript
export interface ResolveMergeConflictsMetadata {
  /** Advisory snapshot of conflicted paths at pause time. */
  conflictedPathsAtPause?: string[];
  /** Advisory PR number if monitor resolved it. */
  prNumber?: number;
  /**
   * NEW in #902 (FR-003).
   * Interrupted phase carried in-band from the phase-loop pause site.
   * Populated by the worker at handler dispatch (from the pause-context
   * sidecar in the workflow state store).
   *
   * Absence at handler entry → fail-loud per FR-004 / #889 terminal path.
   * MUST NOT be re-derived from labels — see Q2 answer.
   */
  phase?: WorkflowPhase;
}
```

**Optional at parse time, required at handler entry**: absence triggers the fail-loud path per FR-004. Optional allows the monitor to construct the item without knowing phase (which it doesn't).

### `MergeConflictHandler.handle` return type

**Before** (`#898`):

```typescript
async handle(item: QueueItem, checkoutPath: string): Promise<void>;
```

**After** (`#902`):

```typescript
async handle(item: QueueItem, checkoutPath: string): Promise<HandlerOutcome>;
```

Every terminal branch in the handler now returns a `HandlerOutcome`:

| Handler branch (in current `handle`) | New return |
|---|---|
| No linked PR → `applyBlockedDisposition({ reason: 'no linked PR' })` | `{outcome: 'failed', evidence: ...}` |
| `baseIsAncestor === true` (no-op merge) → `applySuccessDisposition` | `{outcome: 're-armed', startPhase: metadata.phase}` |
| Merge exited cleanly → `pushAndSucceed` → `applySuccessDisposition` | `{outcome: 're-armed', startPhase: metadata.phase}` |
| Merge failed without conflicts → `applyBlockedDisposition` | `{outcome: 'failed', evidence: ...}` |
| Agent CLI failed verification → `applyBlockedDisposition` | `{outcome: 'failed', evidence: ...}` |
| `pushAndSucceed` non-fast-forward → `applyBlockedDisposition` | `{outcome: 'failed', evidence: ...}` |
| `pushAndSucceed` push failed → `applyBlockedDisposition` | `{outcome: 'failed', evidence: ...}` |
| `pushAndSucceed` success → `applySuccessDisposition` | `{outcome: 're-armed', startPhase: metadata.phase}` |

**Fail-loud missing phase (FR-004)**: if `metadata.phase` is `undefined` when a `re-armed` outcome would be returned, the handler returns:

```typescript
{ outcome: 'failed', evidence: { ...blockedEvidence, reason: 'pause-context missing: phase' } }
```

This lands the issue at `blocked:stuck-merge-conflicts` (operator-visible), matching a detector (satisfies FR-006 terminal-outcome invariant). Never re-derives from labels.

### `WorkerResult` — new `postComplete` variant (per Decision 7 in research.md)

**Location**: `packages/orchestrator/src/worker/worker-result.ts` (MODIFIED).

Extends the existing discriminated union:

```typescript
export interface CompletedResult {
  readonly status: 'completed';
  /**
   * NEW in #902.
   * Optional post-complete side-effect the dispatcher runs AFTER
   * queue.complete() — used by MergeConflictHandler's re-arm path
   * to enqueue a `continue` item without colliding against the
   * still-claimed source itemKey (self-deadlock guard per Q1).
   */
  readonly postComplete?: PostCompleteAction;
}

export type PostCompleteAction =
  | { readonly kind: 'rearm'; readonly rearmItem: QueueItem };

export type WorkerResult =
  | CompletedResult
  | {
      readonly status: 'failed-terminal';
      readonly failureMetadata: FailureMetadata;
    };
```

**Rationale**: Layering incursion is minimal (one optional field, one variant). Dispatcher fires the post-complete action inside `runWorker` immediately after `queue.complete()`:

```typescript
// In WorkerDispatcher.runWorker, after result.status === 'completed':
await this.queue.complete(workerId, item);
if (result.postComplete?.kind === 'rearm') {
  await this.queue.enqueueIfAbsent(result.postComplete.rearmItem);
}
```

Dispatcher stays agnostic to the *meaning* of the re-arm — it just enqueues whatever the worker built.

## Modified persistence

### Pause-context sidecar

**Location**: workflow state store at `<checkoutPath>/.generacy/pause-context-<workflowId>.json` (matches `FilesystemWorkflowStore`'s existing state layout under `DEFAULT_STATE_DIR = '.generacy'`).

**Shape**:

```json
{
  "phase": "validate",
  "writtenAt": "2026-07-10T14:23:45.000Z",
  "issueRef": "christrudelpw/sniplink#6"
}
```

**Writer**: `phase-loop.ts`'s `runPrePhaseBaseMerge` at line 912 (before `labelManager.onGateHit`).

**Reader**: `claude-cli-worker.ts` `case 'resolve-merge-conflicts'` at line 314, immediately after checkout completes. Reads the sidecar, mutates `item.metadata.phase`, then invokes `handler.handle(item, checkoutPath)`.

**Absence policy**: absence at reader entry → handler enters fail-loud path via FR-004. Not a crash — a terminal `failed` outcome with evidence blob citing "pause-context missing".

**Cleanup**: the file is deleted after the handler's re-arm outcome fires, in the same worker step that writes the re-arm to the queue. If the delete fails, the next pause overwrites it (writes are unconditional).

**Alternative considered**: extend `WorkflowState`'s existing schema (`packages/workflow-engine/src/store/types.ts`) with an optional `pauseContext` field. Rejected for now because it drags the workflow-engine package into a shape change for a scenario that's orchestrator-specific. If future handlers need pause-context, we lift then.

## Validation rules

- `HandlerOutcome.outcome` — exactly one of the four discriminated values. Compile-time exhaustive.
- `ReArmedOutcome.startPhase` — must be a valid `WorkflowPhase` (`'specify' | 'clarify' | 'plan' | 'tasks' | 'implement' | 'validate'`). Enforced by TypeScript.
- `GatedOutcome.gateLabel` — must start with `waiting-for:`. Enforced by `assertHandlerOutcomeMatchesWorld`.
- `FailedOutcome.evidence` — non-null. Enforced by TypeScript.
- Pause-context JSON — schema-validated at read time by a small zod schema in `worker/pause-context.ts`. Invalid JSON → treated as absent (fail-loud path).
- Post-exit assertion — pending-item shape check requires the enqueued re-arm item's `metadata.startPhase` to match `outcome.startPhase`.

## Relationships

```
runPrePhaseBaseMerge (phase-loop.ts)
    │  writes pause-context sidecar {phase}
    ▼
FilesystemWorkflowStore(checkoutPath)
    │  ├─ existing workflow state    <-- unchanged
    │  └─ pause-context-<workflowId>.json  <-- NEW
    │
    │  (label-monitor / merge-conflict-monitor polls, enqueues resolve-merge-conflicts)
    ▼
ClaudeCliWorker.handle case 'resolve-merge-conflicts'
    │  reads sidecar → item.metadata.phase
    ▼
MergeConflictHandler.handle(item, checkoutPath): HandlerOutcome
    │
    ├─ success/no-op → { outcome: 're-armed', startPhase: metadata.phase }
    ├─ blocked      → { outcome: 'failed', evidence }
    └─ (protocol future: 'gated', 'done')
    │
    ▼
ClaudeCliWorker builds WorkerResult with postComplete rearm payload
    │
    ▼
WorkerDispatcher.runWorker
    │  queue.complete(current) → then queue.enqueueIfAbsent(rearm)
    ▼
Next poll cycle picks up { command: 'continue', startPhase } and re-enters phase loop
```

Every arrow above is transactional at the granularity that matters: pause-context write precedes label; enqueue precedes label cleanup (FR-008); assertion helper reads the *world*, not the return value (FR-006).
