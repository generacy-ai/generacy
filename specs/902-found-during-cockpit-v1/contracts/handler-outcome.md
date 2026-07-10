# Contract: `HandlerOutcome` union + `assertHandlerOutcomeMatchesWorld`

**Feature**: `#902` — codify the terminal-outcome invariant for `MergeConflictHandler` and provide the load-bearing runtime assertion helper.

## `HandlerOutcome` union (FR-005)

**File**: `packages/orchestrator/src/worker/handler-outcome.ts`

Discriminated union — the only legal return shape for `MergeConflictHandler.handle`:

```typescript
import type { WorkflowPhase } from './types.js';
import type { BlockedStuckMergeConflictsEvidence } from './merge-conflict-handler.js';

export type HandlerOutcome =
  | { readonly outcome: 're-armed'; readonly startPhase: WorkflowPhase }
  | { readonly outcome: 'gated'; readonly gateLabel: string }
  | { readonly outcome: 'failed'; readonly evidence: BlockedStuckMergeConflictsEvidence }
  | { readonly outcome: 'done' };
```

**Semantics**:

- `re-armed` — the interrupted phase must be re-entered. The dispatcher enqueues `{command: 'continue', startPhase}` for the same itemKey after `queue.complete()` fires on the current handler item.
- `gated` — the issue is now sitting at a `waiting-for:*` label matching `gateLabel`. Detector will pick it up naturally.
- `failed` — the issue is now sitting at a `blocked:*` or `failed:*` marker. Operator intervention required.
- `done` — the issue is terminal (closed / merged / withdrawn). No detector pickup expected.

**Invariants**:

1. Every terminal exit path in `MergeConflictHandler.handle` returns exactly one `HandlerOutcome`. Compile-time exhaustiveness enforces this at the type layer.
2. The returned outcome MUST match the *world* (real label set + queue state) at return time. `assertHandlerOutcomeMatchesWorld` enforces this at the runtime layer.
3. Handlers MUST NOT touch the queue. Re-arm enqueue lives at the dispatcher (Q1-B self-deadlock guard).

## `assertHandlerOutcomeMatchesWorld` helper (FR-006)

**File**: `packages/orchestrator/src/worker/handler-outcome-assertion.ts`

**Signature**:

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

**Rules**:

| `outcome.outcome` | Assertion body | Failure mismatch string |
|---|---|---|
| `re-armed` | `queueSnapshot.pendingItems` contains an entry with `command === 'continue'` and `metadata?.startPhase === outcome.startPhase` | `re-armed(<phase>): no matching pending item found in queue` |
| `gated` | `labels.some(l => l === outcome.gateLabel && l.startsWith('waiting-for:'))` | `gated(<gate>): no matching waiting-for:* label on issue` |
| `failed` | `labels.some(l => l.startsWith('blocked:') || l.startsWith('failed:'))` | `failed: no blocked:* or failed:* marker on issue` |
| `done` | `!labels.some(l => l.startsWith('waiting-for:') \|\| l.startsWith('blocked:') \|\| l.startsWith('failed:'))` | `done: unexpected terminal-blocker label(s): <list>` |

**Return**: `{ok: true}` on match. `{ok: false, mismatch}` with a human-readable diagnostic on miss.

**Callers**:

- **Test fixtures** — every terminal-state check in `merge-conflict-handler.test.ts` wraps its assertion with a call to this helper. Fixture fails on `ok: false`. Applied to `PrFeedbackHandler` fixtures per FR-009 (assertion-only application).
- **Dev-mode assertion (future)** — the helper is pure; production code CAN invoke it after handler exit against a live snapshot. Not enabled by default — reserved for follow-up if operators want a runtime-enforced invariant.

**Failure mode**:

`{ok: false, mismatch}` is the *diagnostic* — it doesn't itself write to labels or take remedial action. Fixture assertions turn it into a test failure. If we ever wire it into prod, the natural response is to log at `error` level and emit a `failure-alert` comment (same shape as `#889`'s terminal path).

## Ordering guarantee (FR-008)

The re-arm path MUST enqueue the `continue` item **before** any label cleanup on the issue.

**Concrete ordering in `WorkerDispatcher.runWorker`** (per `packages/orchestrator/src/services/worker-dispatcher.ts:357-393`):

```typescript
const result = await this.handler(item);
// result.status === 'completed' branch:
await this.queue.complete(workerId, item);              // step 1
if (result.postComplete?.kind === 'rearm') {
  await this.queue.enqueueIfAbsent(result.postComplete.rearmItem);  // step 2
}
// (No label edit here — that already happened inside handler.handle.)
```

But wait — the handler *already* cleared the pause labels via `applySuccessDisposition` before returning. That means from the dispatcher's perspective, "label cleanup" happens *inside* the handler and precedes the outcome return. So the FR-008 ordering constraint applies at the *handler → outcome return → dispatcher* boundary, not at the *dispatcher* boundary:

**Revised concrete ordering (inside `MergeConflictHandler.handle`)**:

```typescript
// success path (agent-resolved or no-op)
const outcome: HandlerOutcome = {
  outcome: 're-armed',
  startPhase: metadata.phase,
};
// Do NOT clear labels yet.
return outcome;
```

**Then in `ClaudeCliWorker.handle`'s `case 'resolve-merge-conflicts'` branch**:

```typescript
const outcome = await mergeConflictHandler.handle(item, checkoutPath);

if (outcome.outcome === 're-armed') {
  // Build rearm item first (does not touch the queue yet).
  const rearmItem: QueueItem = {
    ...item,
    command: 'continue',
    metadata: { startPhase: outcome.startPhase, resumeReason: 'merge-conflict-resolved' },
    priority: Date.now(),
    enqueuedAt: new Date().toISOString(),
    queueReason: 'resume',
  };
  // Return via WorkerResult postComplete — dispatcher enqueues AFTER queue.complete.
  // Label cleanup (inside handler.applySuccessDisposition) has ALREADY happened
  // before we got here — that's the shape mismatch we need to fix.
  ...
}
```

**Actual fix**: the handler must NOT clear labels internally in the `re-armed` path. Move label cleanup out of the handler and into the worker's post-handler branch, so the ordering becomes: build rearm item → enqueue via dispatcher postComplete hook (fires after queue.complete) → then combined `gh issue edit`.

No — that gets the ordering backwards. Re-read FR-008:

> The dispatcher MUST enqueue the `continue` item **before** any label cleanup on the issue.

**Correct ordering** (all inside `ClaudeCliWorker.handle`'s dispatch branch, from the worker's perspective):

```
1. handler.handle(item, checkoutPath)  →  outcome = { 're-armed', startPhase }
   - Handler does NOT clear labels on the re-armed path.
2. Build rearmItem and set worker's WorkerResult.postComplete.
3. Handler.performOwnershipEdit(github, ...)  →  combined `gh issue edit --add-label … --remove-label …`
   - Removes: waiting-for:merge-conflicts, agent:paused, agent:in-progress, completed:merge-conflicts
4. Return WorkerResult { status: 'completed', postComplete: { kind: 'rearm', rearmItem } }
5. Dispatcher's runWorker: queue.complete(item)  →  queue.enqueueIfAbsent(rearmItem)
```

FR-008's ordering *inside* this sequence: step 5's `enqueueIfAbsent` fires AFTER `queue.complete` (which frees the itemKey from in-flight), so no self-deadlock. The label edit (step 3) happens AFTER we've committed to enqueuing (step 2's WorkerResult carries the payload); a crash at step 3 leaves stale labels which the resume-cleanup handles; a crash at step 5 leaves the pause state intact and re-triggerable via the merge-conflict monitor. Every intermediate state is detector-matched or over-labelled.

## Label edit shape (FR-007)

**Preferred**: one combined `gh issue edit --add-label … --remove-label …` invocation.

**Command shape (success path)**:

```
gh issue edit <N> \
  --repo <owner>/<repo> \
  --remove-label completed:merge-conflicts \
  --remove-label waiting-for:merge-conflicts \
  --remove-label agent:in-progress \
  --remove-label agent:paused
```

Note: no `--add-label` because re-arm is direct enqueue (no resume-pair labels needed). The next `continue` item's normal in-progress labels are applied by `LabelManager.onResumeStart` when the phase loop enters.

**Command shape (blocked path — unchanged from `#898`)**:

```
gh issue edit <N> \
  --repo <owner>/<repo> \
  --add-label blocked:stuck-merge-conflicts
```

`waiting-for:merge-conflicts` and `agent:paused` are preserved (operator escalation entrypoint per Ship 1's manual remedy).

**Split-call fallback**: where the GitHub client helper doesn't yet accept a combined edit, split into add-then-remove (per `#849`'s paired-clear reasoning). Split MUST be add-before-remove — a crash between them leaves the issue over-labelled (recoverable), never under-labelled (dead-park class).

## `PrFeedbackHandler` scope (FR-009)

**No signature change** on `PrFeedbackHandler`. Its existing test fixtures gain an assertion wrapper:

```typescript
// In pr-feedback-handler.assertion.test.ts (NEW)
import { assertHandlerOutcomeMatchesWorld } from '../handler-outcome-assertion.js';

// For every existing fixture terminal state, map the fixture's inputs to
// an implied HandlerOutcome and assert against the label+queue snapshot.
const impliedOutcome = deriveImpliedOutcome(fixtureLabels, fixtureQueueState);
const assertion = assertHandlerOutcomeMatchesWorld(
  impliedOutcome,
  fixtureLabels,
  fixtureQueueSnapshot,
);
expect(assertion).toEqual({ ok: true });
```

The `deriveImpliedOutcome` heuristic (fixture-local):

- `waiting-for:*` present → `gated`
- `blocked:*` / `failed:*` present → `failed`
- Neither → `done` (`PrFeedbackHandler` doesn't currently re-arm; if a future fixture surfaces one, it maps to `re-armed`)

If a fixture's world doesn't map cleanly, that's a `#902`-class latent bug — exactly what FR-009 is designed to surface.
