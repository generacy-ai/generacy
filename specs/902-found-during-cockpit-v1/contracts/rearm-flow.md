# Contract: Re-arm flow — pause site → monitor → worker → handler → dispatcher

**Feature**: `#902` — end-to-end sequence for the `MergeConflictHandler` success path re-arm.

## Actors

- **Phase loop pause site** (`packages/orchestrator/src/worker/phase-loop.ts`) — `runPrePhaseBaseMerge` at ~line 912. Knows `phase` exactly.
- **Workflow state store** (`FilesystemWorkflowStore` at `<checkoutPath>/.generacy/`) — persistence surface for the pause-context sidecar.
- **`MergeConflictMonitorService`** (`packages/orchestrator/src/services/merge-conflict-monitor-service.ts`) — polls labels, enqueues `resolve-merge-conflicts` items. Untouched by this ship.
- **`ClaudeCliWorker`** (`packages/orchestrator/src/worker/claude-cli-worker.ts`) — dispatch branch at `case 'resolve-merge-conflicts'` (~line 313). Reads pause-context, invokes handler, builds `WorkerResult` with `postComplete`.
- **`MergeConflictHandler`** (`packages/orchestrator/src/worker/merge-conflict-handler.ts`) — returns `HandlerOutcome`.
- **`WorkerDispatcher`** (`packages/orchestrator/src/services/worker-dispatcher.ts`) — dispatches, `queue.complete()`s, fires `postComplete.kind === 'rearm'` enqueue.

## Sequence — success path (agent-resolved OR no-op)

```
[T=0]  phase-loop.ts runPrePhaseBaseMerge — detects merge conflict
       │
       ├─ writes pause-context: FilesystemWorkflowStore.setPauseContext({ phase })
       │  Location: <checkoutPath>/.generacy/pause-context-<workflowId>.json
       │  Content: { phase: 'validate', writtenAt: '<ISO>', issueRef: 'owner/repo#N' }
       │
       ├─ labelManager.onGateHit('validate', 'waiting-for:merge-conflicts')
       │  Applies: waiting-for:merge-conflicts, agent:paused
       │  Removes: (worker-owned in-progress labels)
       │
       └─ returns PhaseLoopResult { gateHit: true }

[T=poll cycle]  MergeConflictMonitorService.pollRepo detects
       waiting-for:merge-conflicts + agent:paused + no blocked:*
       │
       └─ queue.enqueueIfAbsent({
              command: 'resolve-merge-conflicts',
              metadata: {},  ← still empty; monitor doesn't know phase
              ...
          })

[T=dispatch]  WorkerDispatcher.claim → ClaudeCliWorker.handle(item)
       case 'resolve-merge-conflicts':
       │
       ├─ [git checkout branch]  (existing setup)
       │
       ├─ pauseContext = readPauseContext(FilesystemWorkflowStore, checkoutPath, workflowId)
       │  If null → item.metadata.phase = undefined (fail-loud path fires downstream)
       │  If present → item.metadata.phase = pauseContext.phase
       │
       ├─ outcome = await mergeConflictHandler.handle(item, checkoutPath)
       │
       ├─ (branch on outcome — success path):
       │    if outcome.outcome === 're-armed':
       │        rearmItem = buildRearmItem(item, outcome.startPhase)
       │        // Handler already did the combined label edit before returning.
       │        // Pause-context sidecar cleanup:
       │        await clearPauseContext(FilesystemWorkflowStore, checkoutPath, workflowId)
       │        return WorkerResult { status: 'completed', postComplete: { kind: 'rearm', rearmItem } }
       │
       │    if outcome.outcome === 'failed':
       │        // Handler already added blocked:stuck-merge-conflicts and preserved pause labels.
       │        return WorkerResult { status: 'completed' }  // no postComplete
       │        (evidence emission stays inside handler)

[T=dispatch return]  WorkerDispatcher.runWorker after handler returns:
       │
       ├─ queue.complete(workerId, item)     ← frees itemKey from in-flight SET
       │
       └─ if (result.postComplete?.kind === 'rearm'):
              await queue.enqueueIfAbsent(result.postComplete.rearmItem)
              ← No collision: current itemKey just freed. Enqueue succeeds.

[T=next poll cycle]  Dispatcher polls, claims the new { command: 'continue', startPhase } item.
       ClaudeCliWorker.handle: startPhase resolved from item.metadata (via existing phase resolver),
       phase loop enters at 'validate' (or whatever phase was interrupted).
```

**Critical ordering** (FR-008):

- Pause-context write **before** pause label apply → if write crashes, no pause label = no dead-park.
- Handler combined-label-edit **inside** handler success path → returns AFTER the ownership transition is live.
- `queue.complete` **before** `queue.enqueueIfAbsent` (rearm) → no self-collision.
- Rearm enqueue → next poll picks up → phase loop re-entry.

## Sequence — no-op path (branch already clean at handler entry)

Identical to success path except the handler branch is `baseIsAncestor(checkoutPath, baseRef) === true`. Handler returns `{outcome: 're-armed', startPhase}` immediately after the label edit, without spawning the agent CLI. SC-001 requires the *downstream* state to be indistinguishable from the resolved-by-agent path — same `HandlerOutcome`, same `WorkerResult.postComplete`, same rearm sequence.

## Sequence — failed path (agent didn't resolve OR push failed OR no linked PR)

```
[T=dispatch]  ClaudeCliWorker.handle case 'resolve-merge-conflicts':
       │
       ├─ (as above through outcome resolution)
       │
       ├─ outcome = { outcome: 'failed', evidence }
       │  Handler already:
       │  - added blocked:stuck-merge-conflicts
       │  - preserved waiting-for:merge-conflicts, agent:paused
       │  - emitted structured evidence log line
       │
       ├─ (no rearm — outcome is terminal)
       ├─ (do NOT clear pause-context sidecar — operator may need context)
       │
       └─ return WorkerResult { status: 'completed' }  ← no postComplete

[T=dispatch return]  WorkerDispatcher.runWorker:
       │
       ├─ queue.complete(workerId, item)
       │
       └─ no postComplete action.

Operator sees: blocked:stuck-merge-conflicts + waiting-for:merge-conflicts + agent:paused +
              evidence in stage comment. Escalation via Ship 1's manual remedy applies.
```

## Sequence — fail-loud missing pause-context (FR-004)

```
[T=dispatch]  ClaudeCliWorker.handle case 'resolve-merge-conflicts':
       │
       ├─ pauseContext = readPauseContext(...)
       │  Returns null (file missing, corrupted, or wrong workflowId)
       │
       ├─ item.metadata.phase = undefined
       │
       ├─ outcome = await mergeConflictHandler.handle(item, checkoutPath)
       │  Handler sees metadata.phase undefined at re-arm branch entry:
       │    - applies blocked:stuck-merge-conflicts (fail-loud)
       │    - preserves waiting-for:merge-conflicts, agent:paused
       │    - emits evidence: reason='pause-context missing: phase'
       │    - returns { outcome: 'failed', evidence: { ..., reason: '...' } }
       │
       └─ return WorkerResult { status: 'completed' }  ← operator escalation
```

## `WorkerResult` extension (per Decision 7 in research.md)

```typescript
export interface PostCompleteAction {
  readonly kind: 'rearm';
  readonly rearmItem: QueueItem;
}

export type WorkerResult =
  | { readonly status: 'completed'; readonly postComplete?: PostCompleteAction }
  | { readonly status: 'failed-terminal'; readonly failureMetadata: FailureMetadata };
```

**Dispatcher change** — `WorkerDispatcher.runWorker` at `worker-dispatcher.ts:389`:

```typescript
// Success: complete the item
await this.queue.complete(workerId, item);

// #902: fire post-complete action AFTER queue.complete releases the itemKey
if (result.postComplete?.kind === 'rearm') {
  try {
    const enqueued = await this.queue.enqueueIfAbsent(result.postComplete.rearmItem);
    if (!enqueued) {
      this.logger.warn(
        { workerId, rearmItemKey: `${result.postComplete.rearmItem.owner}/${result.postComplete.rearmItem.repo}#${result.postComplete.rearmItem.issueNumber}` },
        'Rearm enqueue dropped (already in-flight) — deferred to next poll',
      );
    }
  } catch (err) {
    this.logger.error({ err, workerId }, 'Rearm enqueue threw — pause labels intact for next poll');
  }
}

this.logger.info(...);
```

**Fault tolerance**:

- Enqueue drop (in-flight collision) → the next merge-conflict monitor poll re-fires the whole cycle. Handler pause-context sidecar is still on disk, still readable.
- Enqueue throw → same recovery path. Fatal `queue.complete` errors already propagate.
- The `try/catch` around the `enqueueIfAbsent` is critical: throwing here would skip the dispatcher's `finally` block and leak resources.

## Pause-context sidecar API

**File**: `packages/orchestrator/src/worker/pause-context.ts` (NEW).

```typescript
export interface PauseContext {
  readonly phase: WorkflowPhase;
  readonly writtenAt: string;        // ISO
  readonly issueRef: string;         // 'owner/repo#N'
}

/** Write pause-context sidecar. Overwrites existing file unconditionally. */
export async function writePauseContext(
  store: FilesystemWorkflowStore,
  workflowId: string,
  ctx: PauseContext,
): Promise<void>;

/** Read pause-context sidecar. Returns null if missing or invalid. */
export async function readPauseContext(
  store: FilesystemWorkflowStore,
  workflowId: string,
): Promise<PauseContext | null>;

/** Delete pause-context sidecar. Idempotent — no error if already gone. */
export async function clearPauseContext(
  store: FilesystemWorkflowStore,
  workflowId: string,
): Promise<void>;
```

**Location on disk**: `<workdir>/.generacy/pause-context-<sanitized-workflowId>.json` (mirrors `FilesystemWorkflowStore.getStateFilePath` sanitization at `store/filesystem-store.ts:161`).

**Validation** — read time: JSON.parse + zod schema check. Invalid JSON or missing fields → return `null` (treated as absent, triggers fail-loud path).

## Regression tests

Per FR-006 the *runtime* helper is load-bearing. Every terminal state in the fixtures below wraps its assertion with `assertHandlerOutcomeMatchesWorld`:

| Test file | Scenario | Terminal state |
|---|---|---|
| `merge-conflict-handler.rearm.test.ts` | Agent resolves conflict, push succeeds | `re-armed` + queue has `continue` item |
| `merge-conflict-handler.noop.test.ts` | `baseIsAncestor === true` at entry | `re-armed` + queue has `continue` item (identical to above) |
| `merge-conflict-handler.second-cycle.test.ts` | Second conflict after first successful cycle | Second handler invocation is NOT insta-resumed |
| `merge-conflict-handler.fail-loud.test.ts` | pause-context sidecar missing | `failed` + evidence.reason includes `pause-context missing` |
| `merge-conflict-handler.blocked.test.ts` | Agent CLI fails to produce clean merge | `failed` + `blocked:stuck-merge-conflicts` |
| `merge-conflict-handler.no-pr.test.ts` | No linked PR resolvable | `failed` + `blocked:stuck-merge-conflicts` |
| `pr-feedback-handler.assertion.test.ts` | Existing PrFeedbackHandler fixtures | Every terminal state asserts cleanly |
