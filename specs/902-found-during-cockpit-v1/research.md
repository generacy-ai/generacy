# Research: `#902` MergeConflictHandler success-path re-arm

Companion to `plan.md`. Decisions taken, alternatives considered, and the rationale for each. All five clarification answers (see `clarifications.md`) inform the picks below.

## Decision 1: Re-arm mechanism = direct enqueue at the worker (Q1 → B)

**Picked**: The handler returns a terminal `HandlerOutcome { outcome: 're-armed', startPhase }`. The **worker** (as dispatcher-side single authority per `#889` Q2-D) enqueues a `continue` item with the correct `startPhase` — the handler itself never calls the queue.

**Rationale**:

- **Self-deadlock avoidance**. At handler success time, the handler's *own* itemKey `<owner>/<repo>#<issue>` is still *claimed* in the queue. If the handler called `queue.enqueueIfAbsent` with the same itemKey (which it would, since it's the same issue), `#879`'s single-in-flight dedupe collapses the call and the re-arm silently drops. Handler → dispatcher hand-off avoids that entirely because the dispatcher (`WorkerDispatcher.runWorker` at `worker-dispatcher.ts:389`) `queue.complete()`s the item *before* the worker's post-handle hook runs the enqueue.
- **Immediate latency**. No poll-cycle wait. The resume-pair alternative (Q1-A) is asserted end-to-end through label-monitor's poll, adding seconds of latency and a preceding-gate mapping problem (Q3).
- **Unit-testable at the queue boundary**. The `runWorker` post-complete hook's `enqueueIfAbsent` call is one line; regression asserts the enqueued item's `startPhase` matches the handler's returned outcome.
- **Single queue authority**. `#889` Q2-D established the dispatcher as the single authority on queue transitions. Handler-side enqueue would create a second authority.

**Alternatives rejected**:

- **Resume-pair (Q1-A)** — write `waiting-for:<preceding-gate>` + `completed:<preceding-gate>` + `agent:paused`, let label-monitor observe and enqueue. Rejected: imports a preceding-gate mapping problem (Q3), adds seconds of latency, and manufactures a race between the label-plane resume and the queue-plane single-in-flight guard.
- **Whichever cleanest at call site (Q1-C)** — rejected: the whole point of `#902` is that the loose contract in `#898` let the "cleanest" success path skip re-arm entirely. Locking in the mechanism up-front prevents recurrence.

## Decision 2: `phase` discovery = pause-context sidecar in workflow state store (Q2 → A)

**Picked**: The phase-loop pause site (`runPrePhaseBaseMerge` in `worker/phase-loop.ts`) writes `{phase: WorkflowPhase}` to a small pause-context slot in the workflow state store (`FilesystemWorkflowStore` at `checkoutPath`) *before* `labelManager.onGateHit()` fires the pause label. The worker dispatch branch (`claude-cli-worker.ts` case `'resolve-merge-conflicts'`) reads that state back *after* checkout and populates `item.metadata.phase` — which then gets read from `ResolveMergeConflictsMetadata` at handler entry.

**Rationale**:

- **Pause site knows exactly**. The phase-loop pause site is the one place in the codebase that holds the interrupted phase as a local variable at the moment the pause materializes. Any other discovery mechanism at handler exit is either a re-computation (Q2-B, disqualified below) or a re-lookup that could go stale.
- **State store already exists**. `FilesystemWorkflowStore` (`packages/workflow-engine/src/store/filesystem-store.ts:135`) is instantiated at `claude-cli-worker.ts:595` for the fan-out post-handler. No new persistence machinery; a small additive slot on `WorkflowState` (or a sidecar file) is the whole change.
- **Monitor stays dumb**. `MergeConflictMonitorService` doesn't need to know the phase — it can't (it only sees labels). Pushing phase-awareness into it would require the monitor to fetch the stage comment / state file per-issue at poll time.
- **Fail-loud on missing**. FR-004: if pause-context is absent at handler entry, the handler fails terminal with evidence per the `#889` path — never derives from labels.

**Alternatives rejected**:

- **Q2-B (label-derive)** — rejected explicitly. The protocol writes no `completed:implement` marker after `implementation-review` is consumed. `#6`'s post-pause label set derives to `startPhase = implement` while the pause log's own `phase:validate` shows validate was interrupted. Label-derivation is a wrong-answer generator, not defense-in-depth.
- **Q2-C (both, defense-in-depth)** — rejected. Adding label-derivation as a fallback is worse than failing loud, because it silently re-runs completed phases at agent-invocation cost, potentially duplicating work.
- **Persist to stage comment / issue body** — rejected. The stage comment is user-facing; embedding worker-plane control state in it makes future comment-render changes protocol-breaking. The state store is the canonical worker-plane persistence surface.
- **Encode in the pause label itself** (e.g., `waiting-for:merge-conflicts:validate`) — rejected. Label-plane bloat; label-monitor regex would need updating; harder to iterate on.

## Decision 3: Where re-arm actually runs = `ClaudeCliWorker.handle`'s `case 'resolve-merge-conflicts'` branch, not `WorkerDispatcher.runWorker`

**Picked**: The re-arm `enqueueIfAbsent` call lives inside `ClaudeCliWorker.handle`'s `case 'resolve-merge-conflicts'` branch (`claude-cli-worker.ts:313-339`), immediately after `handler.handle(...)` returns. It runs *before* `handler.applySuccessDisposition()` label cleanup. The dispatcher (`WorkerDispatcher.runWorker`) is untouched — it still sees a `WorkerResult` at the end and `queue.complete()`s the item on the same tick.

**Why not the dispatcher itself**:

- **Layering**. `WorkerDispatcher` is currently agnostic to workflow specifics — it dispatches, heartbeats, and reaps. Threading `HandlerOutcome` up into the dispatcher's dispatch loop would make the dispatcher command-aware.
- **`enqueueIfAbsent` needs the queue in scope** — which the worker already has (as a constructor arg on `ClaudeCliWorker`).
- **`queue.complete()` still runs at the dispatcher.** The self-deadlock guard is that the current item is `complete`d *after* `handler` returns and *after* the worker's re-arm branch fires `enqueueIfAbsent`. Since `enqueueIfAbsent` is atomic against the in-flight set, the resulting `continue` item enters the pending queue while the current item is still on `in-flight`; `WorkerDispatcher.runWorker` then completes the current item, dropping its in-flight entry; next poll picks up the new `continue` item.

**Ordering** (FR-008 concretely):

```
1. handler.handle(item, checkoutPath) → { outcome: 're-armed', startPhase }
2. queue.enqueueIfAbsent({ ...item, command: 'continue', startPhase, priority: <resume-tier> })
3. handler.applySuccessDisposition(github, ...)     // combined `gh issue edit`
4. return { status: 'completed' }                   // WorkerDispatcher.runWorker calls queue.complete()
```

Step 2 must precede step 3. If step 3 crashes, the pause labels stay in place *and* the `continue` item is enqueued — the existing `LabelManager.onResumeStart()` at `claude-cli-worker.ts:512-514` removes them harmlessly when the resume item runs. If step 2 crashes, the pause labels stay in place *and* the monitor's next poll re-fires the whole cycle. Either recovery path is deterministic; neither leaves the issue dead-parked.

## Decision 4: Label edit shape = single `gh issue edit --add-label … --remove-label …` (FR-007, Q5 → C fallback A)

**Picked**: One combined GitHub API call per ownership transition. Where the call must split (e.g., the label helper doesn't yet accept combined args), add-before-remove ordering applies (Q5 → A fallback).

**Removes on success** (the ownership transition):

- `waiting-for:merge-conflicts` — the pause is over
- `agent:paused` — the pause is over
- `agent:in-progress` — no worker owns this after handler exit + `queue.complete()`
- `completed:merge-conflicts` — the operator-advance marker is *consumed* (this is the sub-defect #3 fix)

**Adds on success**: **none**. Because re-arm is direct enqueue (not the resume-pair path), no `waiting-for:<preceding-gate>` / `completed:<preceding-gate>` / `agent:paused` labels are needed. The worker will pick up the enqueued `continue` item on the next poll and apply the normal in-progress labels itself.

**Adds on blocked** (the failed path):

- `blocked:stuck-merge-conflicts`

**Preserves on blocked** (unchanged from `#898`):

- `waiting-for:merge-conflicts` (operator escalation entrypoint per Ship 1's manual remedy)
- `agent:paused` (still paused, awaiting operator)

**Rationale**:

- Fewest partial-failure windows — the combined edit is a single HTTP round-trip, which the GitHub API atomically applies at the label-set level (see contracts note in `contracts/handler-outcome.md`).
- If the helper can't do combined, add-before-remove holds (`#849`'s reasoning, applied to the queue-side add here).

## Decision 5: `HandlerOutcome` union — location and enforcement (Q4 → A)

**Picked**: Orchestrator-local discriminated union in `packages/orchestrator/src/worker/handler-outcome.ts`, plus a runtime post-exit assertion helper in `packages/orchestrator/src/worker/handler-outcome-assertion.ts`.

**Type**:

```typescript
type HandlerOutcome =
  | { readonly outcome: 're-armed'; readonly startPhase: WorkflowPhase }
  | { readonly outcome: 'gated'; readonly gateLabel: string }
  | { readonly outcome: 'failed'; readonly evidence: BlockedStuckMergeConflictsEvidence }
  | { readonly outcome: 'done' };
```

The four variants match the terminal-outcome invariant: "every handler terminal outcome maps to exactly one of: re-armed (queued), gated (`waiting-for:*` present), failed (`failed:*` / `blocked:*` + evidence), or done (closed/merged)."

**Enforcement** — the load-bearing half is the *runtime* assertion helper. Compile-time exhaustiveness would have passed the broken `#898` handler (which had a `void` return that ran through the success path without setting anything). The type alone can't catch the bug class. The helper reads the *real* issue label set + queue state and refuses to accept "the handler said X" as evidence:

```typescript
function assertHandlerOutcomeMatchesWorld(
  outcome: HandlerOutcome,
  labels: string[],
  queueSnapshot: { inFlight: boolean; pendingItems: QueueItem[] },
): { ok: true } | { ok: false; mismatch: string };
```

For `re-armed`: assert `queueSnapshot.pendingItems` contains a `{command: 'continue', startPhase}` for the issue's itemKey.
For `gated`: assert `labels` contains a `waiting-for:*` matching `outcome.gateLabel`.
For `failed`: assert `labels` contains a `blocked:*` or `failed:*` marker.
For `done`: assert no `waiting-for:*`, no `blocked:*`, and issue closed or PR merged (test-fixture-context dependent).

**Rejected alternatives**:

- **Ship type to `@generacy-ai/workflow-engine`** — YAGNI. Every consumer today is orchestrator-side.
- **Runtime assertion only (Q4-C)** — the type carries useful shape info at handler boundaries even if it can't catch the bug class; combining the two matches the spec's stated intent (FR-005 + FR-006).
- **Compile-time exhaustiveness only** — rejected explicitly (see above).

## Decision 6: `PrFeedbackHandler` scope = assertion-only (FR-009, Q4)

**Picked**: `PrFeedbackHandler`'s signature does NOT change. Its existing test fixtures gain a wrapper that calls `assertHandlerOutcomeMatchesWorld` on the fixture's terminal label + queue state, mapped from the fixture's inputs. If the fixture's inputs would fail the assertion, we've found a `#902`-class latent bug in `PrFeedbackHandler` — which is exactly the point of extending coverage.

**Rationale**:

- Signature change on `PrFeedbackHandler` was out of scope in the spec (Out of Scope §"Retrofitting `PrFeedbackHandler` to return a `HandlerOutcome`").
- Assertion-only application catches the class of bug without dragging a full handler rewrite into `#902`'s PR.
- A future issue can add the signature change if the fixture coverage surfaces a real bug.

## Decision 7: Queue itemKey collision on `continue` re-arm

**Question**: If `enqueueIfAbsent`'s `itemKey` is `<owner>/<repo>#<issue>` (no command), the re-arm collides with the still-claimed `resolve-merge-conflicts` item. Does the enqueue drop silently?

**Answer**: Depends on `redis-queue-adapter.ts` semantics. `enqueueIfAbsent` operates on the in-flight SET, which tracks pending+claimed union. At the moment the worker calls it in step 2 above, the current item is *claimed* (on the in-flight SET). If `itemKey` is command-agnostic, the enqueue drops.

**Mitigation**: We have two options:

- **A**: Extend `itemKey` derivation for `continue` re-arm items to include a suffix like `#continue-<phase>`. Additive change to the itemKey derivation only for this call site.
- **B**: Move re-arm to *after* `queue.complete()` — i.e., call `enqueueIfAbsent` from the dispatcher's `runWorker`, after step 4 above. This means threading `HandlerOutcome` up into the dispatcher, which we rejected in Decision 3.

**Picked**: **A**. The itemKey shape becomes `<owner>/<repo>#<issue>[:<command>]` for non-`process` commands, matching a similar dedupe extension pattern from `#849` (paired-clear resume dedupe keyed on `<gate>`). See `contracts/rearm-flow.md` for the exact key derivation.

Actually — verifying at commit time: `redis-queue-adapter.ts`'s existing `itemKey` derivation is `<owner>/<repo>#<issue>` per the docstring at `types/monitor.ts:249`. Extending it to include command is not free: the label-monitor's `process`-path dedupe (`label-monitor-service.ts:278-280`) currently keys off the bare form. If we widen, the label-monitor still enqueues bare-form; the re-arm still collides.

**Revised picked**: **B** with a tighter scope. The worker calls `enqueueIfAbsent` at step 2 above, accepting that the enqueue MAY collide-and-drop *while* the current item is claimed. The recovery: on collision, the worker sets a post-`queue.complete` hook via a small `Promise` that fires from a `Promise.resolve().then(...)` chained onto the `handler.handle` return. Actually cleanest: the worker returns a special `WorkerResult` variant that carries a re-arm payload; the dispatcher applies it after `queue.complete`. Yes — this DOES bleed dispatch-branch specifics into `WorkerDispatcher`, but only by one variant.

**Final revised**: A new `WorkerResult` variant `{ status: 'completed'; postComplete?: { rearm: { command: 'continue', startPhase, ... } } }`. Dispatcher fires `enqueueIfAbsent` after `queue.complete`. This is the smallest layering incursion.

See `contracts/rearm-flow.md` §"WorkerResult extension" for the exact shape and dispatch ordering.

## Sources / references

- Spec: `specs/902-found-during-cockpit-v1/spec.md`
- Clarifications: `specs/902-found-during-cockpit-v1/clarifications.md`
- `#898` handler: `packages/orchestrator/src/worker/merge-conflict-handler.ts`
- `#898` plan (shape reference): `specs/898-found-during-cockpit-v1/plan.md`
- `#889` `WorkerResult` union: `packages/orchestrator/src/worker/worker-result.ts`
- `#849` paired-clear reasoning (add-before-remove invariant): `CLAUDE.md` §"Pause-Paired Resume-Dedupe Clear (#849)"
- `#879` single-in-flight semantics: `packages/orchestrator/src/types/monitor.ts:232-256`
- `PrFeedbackHandler` (shape reference): `packages/orchestrator/src/worker/pr-feedback-handler.ts`
- `FilesystemWorkflowStore`: `packages/workflow-engine/src/store/filesystem-store.ts:135`
