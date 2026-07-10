# Implementation Plan: `MergeConflictHandler` success path re-arms the interrupted phase (`#902`)

**Feature**: Fix the `#898` `MergeConflictHandler` success path so it re-arms the interrupted phase, clears the operator-advance marker (`completed:merge-conflicts`) and the zombie ownership label (`agent:in-progress`), and never leaves an issue in a state no detector matches. Codify the invariant with a `HandlerOutcome` discriminated union + a load-bearing post-exit runtime assertion that reads the *real* label set + queue state.
**Branch**: `902-found-during-cockpit-v1`
**Status**: Complete

## Summary

`#898` shipped the merge-conflict resolution handler. Its success path (agent-resolved or no-op-because-already-resolved) removes `waiting-for:merge-conflicts` + `agent:paused` and adds `completed:merge-conflicts`, then returns. It does not re-arm the interrupted phase, does not remove the operator-advance marker (so a second future conflict pause insta-resumes), and does not clear `agent:in-progress` (so the issue reads as "worker owns this" while no worker does). Result on sniplink#6/#7/#8: dead-park matching no detector (pair-path needs `waiting-for`/`completed` pair, `#892` needs `failed:validate`, `#891` needs `failed:*`).

This spec ships three things together in one PR:

1. **Re-arm path** — success path returns a terminal `HandlerOutcome`; the worker (as dispatcher, per `#889` Q2-D single-authority) enqueues a `continue` item with the correct `startPhase` **before** cleaning up any labels (`#849` add-before-remove invariant, applied to the queue/label ordering).
2. **Phase discovery** — `ResolveMergeConflictsMetadata.phase: WorkflowPhase` is populated from the pause site in `phase-loop.ts`'s `runPrePhaseBaseMerge` (the one place that *knows* the interrupted phase). Discovery path: pause site persists phase to a small pause-context sidecar in the workflow state store; the worker reads it back at handler dispatch time and threads it onto `item.metadata`. Missing metadata → fail loud per `#889` terminal path — **no label-derivation fallback** (Q2 rejects B/C: the protocol writes no `completed:implement` marker after `implementation-review` is consumed, so derivation is a wrong-answer generator).
3. **Terminal-outcome invariant** — `HandlerOutcome = { re-armed | gated | failed | done }` discriminated union in `packages/orchestrator/src/worker/` + a runtime `assertHandlerOutcomeMatchesWorld()` helper that reads the actual issue labels + queue state and refuses to accept "the handler said X". Applied to `MergeConflictHandler` in-tree; `PrFeedbackHandler` gets fixture-level assertion coverage only (no handler-signature rewrite).

Label mutation on the ownership transition uses one combined `gh issue edit --add-label … --remove-label …` invocation (fewest partial-failure windows; where calls must split, add-before-remove ordering applies per `#849`'s paired-clear reasoning).

## Technical Context

- **Language**: TypeScript, Node.js `>= 22`, ESM.
- **Primary packages touched**:
  - `packages/orchestrator/` — `MergeConflictHandler` return-type + success-path change; new `HandlerOutcome` union; new `handler-outcome-assertion.ts` helper; `phase-loop.ts` pause-site pause-context persistence; `types/monitor.ts` `ResolveMergeConflictsMetadata.phase` field; `claude-cli-worker.ts` dispatch branch reads pause-context, threads outcome to enqueue path.
  - `packages/workflow-engine/` — no shape changes (`FilesystemWorkflowStore` already exports the store constructor used at `claude-cli-worker.ts:595`; the pause-context sidecar reuses the same `.generacy/` state directory pattern).
- **Deps** (no new packages):
  - `@generacy-ai/workflow-engine`'s `FilesystemWorkflowStore` — existing persistence surface used for the pause-context sidecar.
  - `GhCliGitHubClient.editLabels` (or an equivalent thin wrapper over `gh issue edit --add-label … --remove-label …`) — one call per ownership transition.
- **Relevant existing surfaces reused verbatim**:
  - `QueueManager.enqueueIfAbsent` (`packages/orchestrator/src/types/monitor.ts:250`) — sole re-arm dedupe (per `#879` single-in-flight; the `re-armed` branch collides against the *handler's own* itemKey, which is why re-arm runs *at the worker*, not inside the handler — Q1's self-deadlock rationale).
  - `WorkerDispatcher.runWorker` (`packages/orchestrator/src/services/worker-dispatcher.ts:352`) — the `handler(item)` return already discriminates `completed | failed-terminal`; the new outcome routing lives one layer above, in `ClaudeCliWorker.handle`'s `case 'resolve-merge-conflicts'` branch.
  - `MergeConflictMonitorService` (`packages/orchestrator/src/services/merge-conflict-monitor-service.ts:62`) — untouched. It doesn't know the phase (only labels), and it doesn't need to: the pause-context is workspace-local and the worker reads it at dispatch time.
  - `LabelManager` (`packages/orchestrator/src/worker/label-manager.ts`) — untouched at the shape level; the ownership-transition edit goes through a new one-shot helper (`gh issue edit --add-label … --remove-label …`) rather than the two-call `addLabels`/`removeLabels` sequence in `applySuccessDisposition`.
  - `#849`'s add-before-remove invariant — applies to the *queue/label* ordering here (enqueue BEFORE label cleanup, so a crash between them leaves the state re-triggerable, never under-labelled).
- **Constitution**: no `.specify/memory/constitution.md` present — no additional gate.

## Ship boundaries

Single ship. Not decomposable — the three requirements interlock:

- Removing `completed:merge-conflicts` without re-arming = worker never picks up the issue.
- Re-arming without removing `agent:in-progress` = ownership races between the enqueued item and the "still owned" ghost worker.
- Re-arming + label cleanup without the assertion helper = we ship the same class of bug (tests pass, world diverges).

Reversibility: the change is contained to two files in `packages/orchestrator/src/worker/` (handler + worker dispatcher) plus a small `types/monitor.ts` field addition. The pause-context sidecar is additive (no schema break — absent sidecar reads as "phase unknown → fail loud", which is the FR-004 path anyway).

## Project structure

```
packages/orchestrator/
  src/
    worker/
      merge-conflict-handler.ts                # MODIFIED — return type becomes HandlerOutcome; success path adds
                                               #   re-armed with startPhase from item.metadata.phase; combined
                                               #   `gh issue edit` label call (FR-007)
      handler-outcome.ts                       # NEW — HandlerOutcome discriminated union (FR-005)
      handler-outcome-assertion.ts             # NEW — assertHandlerOutcomeMatchesWorld() runtime helper (FR-006)
      claude-cli-worker.ts                     # MODIFIED — case 'resolve-merge-conflicts': read pause-context,
                                               #   thread metadata.phase; on HandlerOutcome 're-armed', enqueueIfAbsent
                                               #   BEFORE label cleanup (FR-008)
      phase-loop.ts                            # MODIFIED — runPrePhaseBaseMerge writes pause-context
                                               #   {phase} to workflow state BEFORE labelManager.onGateHit
      __tests__/
        merge-conflict-handler.test.ts         # MODIFIED — existing fixtures updated for HandlerOutcome return;
                                               #   assertion helper attached to every fixture (FR-006)
        merge-conflict-handler.rearm.test.ts   # NEW — end-to-end fixture: pause → handler success → worker re-runs
                                               #   interrupted phase (assert phase-loop re-entry, not exit code)
        merge-conflict-handler.noop.test.ts    # NEW — no-op branch (branch already clean at entry) produces
                                               #   identical downstream state to resolved-by-agent
        merge-conflict-handler.second-cycle.test.ts  # NEW — second conflict pause after successful cycle triggers
                                                     #   handler again (no stale-marker insta-resume)
        pr-feedback-handler.assertion.test.ts  # NEW — FR-009: assertion-only coverage attached to existing
                                               #   PrFeedbackHandler fixtures; no handler signature change
    types/
      monitor.ts                               # MODIFIED — ResolveMergeConflictsMetadata gains phase: WorkflowPhase (FR-003)
specs/902-found-during-cockpit-v1/
  contracts/
    handler-outcome.md                         # NEW — HandlerOutcome type + assertion contract
    rearm-flow.md                              # NEW — pause → monitor → worker → handler → enqueue sequence
  data-model.md                                # NEW — types & entities
  research.md                                  # NEW — decisions + alternatives
  quickstart.md                                # NEW — how to exercise the fix locally
```

**Structure Decision**: Single-package fix (orchestrator only). No cross-package moves — Q3 → C: `HandlerOutcome` is orchestrator-local until a second package needs it (YAGNI on `@generacy-ai/workflow-engine`); Q4 confirms.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

No `.specify/memory/constitution.md` present. No gate to check.

## Key files, existing anchors

- `packages/orchestrator/src/worker/merge-conflict-handler.ts:115` — `handle(item, checkoutPath): Promise<void>` — return type change to `Promise<HandlerOutcome>` (breaking change to a single caller).
- `packages/orchestrator/src/worker/merge-conflict-handler.ts:596-625` — `applySuccessDisposition` — the exact site the bug lives. FR-001 (remove `completed:merge-conflicts` + `agent:in-progress`) and FR-007 (combined `gh issue edit`) land here.
- `packages/orchestrator/src/worker/merge-conflict-handler.ts:211-218` — no-op branch (`baseIsAncestor`). Must return identical outcome to the resolved-by-agent path (SC-001 fixture).
- `packages/orchestrator/src/worker/phase-loop.ts:912-968` — `runPrePhaseBaseMerge` pause site. FR-003 pause-context write inserts *before* `labelManager.onGateHit` (line 961) so a durable phase snapshot exists before the label that triggers the monitor is applied.
- `packages/orchestrator/src/worker/claude-cli-worker.ts:313-339` — `case 'resolve-merge-conflicts'` dispatch branch. Reads pause-context from workflow state, threads `metadata.phase`, invokes `handler.handle(item, checkoutPath)`, branches on `HandlerOutcome`.
- `packages/orchestrator/src/types/monitor.ts:56-61` — `ResolveMergeConflictsMetadata` shape. Gains `phase: WorkflowPhase`.
- `packages/orchestrator/src/services/merge-conflict-monitor-service.ts:157-167` — queue-item construction. **No change** — the monitor doesn't know the phase; the worker reads it from the state store at dispatch.
- `packages/orchestrator/src/types/monitor.ts:250` — `enqueueIfAbsent` — the sole re-arm path. Invoked at the worker (not the handler) because the handler's own itemKey is still claimed at success time (Q1 self-deadlock guard).
- `packages/orchestrator/src/worker/label-manager.ts` — untouched at the shape level. The success-path ownership edit calls a new one-shot helper (`gh issue edit --add-label … --remove-label …`) rather than the two-call `addLabels`/`removeLabels` pair.
- `packages/orchestrator/src/worker/pr-feedback-handler.ts` — untouched at the shape level. Existing fixtures gain the runtime assertion helper wrapper.

## Sequencing (ordered)

1. **Add `HandlerOutcome` union** (`worker/handler-outcome.ts`, new). No consumers yet — pure type addition, compiles green.
2. **Add `assertHandlerOutcomeMatchesWorld` helper** (`worker/handler-outcome-assertion.ts`, new). Pure-function shape: reads a snapshot `(labels: string[], queueSnapshot: {inFlight: boolean, pendingItems: QueueItem[]})` and returns `{ok: true} | {ok: false, mismatch: string}`. Test infrastructure snapshotting lives in fixtures; helper is pure so it's callable from prod code too if we ever want a dev-mode assertion (not enabled by default).
3. **Extend `ResolveMergeConflictsMetadata.phase`** (`types/monitor.ts`). Additive optional-at-parse-time; handler treats absence as fail-loud per FR-004.
4. **Persist pause-context at phase-loop pause site** (`worker/phase-loop.ts:912-968`). Write `{phase}` to the workflow state store (`FilesystemWorkflowStore` at `checkoutPath`) BEFORE `labelManager.onGateHit`. Order matters: if the write fails, the pause label is never applied, so the pause simply doesn't materialize (no dead-park class introduced).
5. **Read pause-context at worker dispatch** (`worker/claude-cli-worker.ts:313-339`). After `git checkout` completes, load state from `FilesystemWorkflowStore(checkoutPath)` and populate `item.metadata.phase`. Absence → the handler's fail-loud path fires (FR-004).
6. **Handler success path** (`worker/merge-conflict-handler.ts:596-625`). Replace the two-call `addLabels`/`removeLabels` pair with a combined `gh issue edit --add-label agent:paused --remove-label completed:merge-conflicts --remove-label waiting-for:merge-conflicts --remove-label agent:in-progress --remove-label agent:paused` — see `research.md` §"Label edit shape" for the exact set (`agent:paused` addition is the `#849`-shape ownership indicator until the worker's `enqueueIfAbsent` fires the `continue`). Wait — actually simpler: since re-arm is direct enqueue not resume-pair, we don't need to add `agent:paused`. The set is *just removes*: `completed:merge-conflicts`, `waiting-for:merge-conflicts`, `agent:in-progress`, `agent:paused`. See `research.md` for the derivation.
7. **Handler return type** — `MergeConflictHandler.handle` returns `HandlerOutcome`:
   - No-op / agent-resolved → `{outcome: 're-armed', startPhase: metadata.phase}`
   - Blocked (agent failed, non-fast-forward push, no-PR) → `{outcome: 'failed', evidence}`
   - `agent:paused`/`waiting-for:merge-conflicts` preserved on blocked = `gated`… actually the blocked path adds `blocked:stuck-merge-conflicts` and preserves `waiting-for:merge-conflicts` — the terminal-outcome invariant maps that to `failed` because `blocked:*` is a fail-terminal marker (the operator has to intervene). See `contracts/handler-outcome.md`.
8. **Worker dispatch re-arm** (`worker/claude-cli-worker.ts:313-339`). On `HandlerOutcome 're-armed'`:
   1. `queueManager.enqueueIfAbsent({command: 'continue', workflowName, startPhase: outcome.startPhase, ...})` — this MAY fail with in-flight collision because the *current* item is still claimed; that's fine, the dedupe key differs when the queue implementation includes command in itemKey; if not, the crash-then-retry path recovers (worker's own `queue.complete` fires next in `WorkerDispatcher.runWorker`, releasing the itemKey, then the resume-monitor's next poll re-picks it — but pause labels were cleared, so it won't).

      **Alternative** (cleaner): the worker sets a "post-complete re-arm" hook that fires from `WorkerDispatcher.runWorker` *after* `queue.complete(item)` at line 389. See `research.md` §"Where does re-arm actually happen?" for the pick.
   2. Then run label cleanup (via the handler's own success-disposition helper on the merged edit) — this is FR-008's ordering.
9. **Re-arm before cleanup** invariant test (FR-008): if enqueue succeeds but cleanup crashes, the next monitor poll sees stale pause labels; the existing resume-cleanup path (LabelManager `onResumeStart` at `claude-cli-worker.ts:512-514`) removes them harmlessly, and `#879` in-flight dedupe collapses the resulting label-monitor/webhook re-enqueue race. If enqueue crashes before cleanup, the pause labels stay in place and the monitor re-fires next cycle. Either side is recoverable; neither is a dead-park.
10. **Handler fixtures** — update every existing `merge-conflict-handler.test.ts` fixture to assert the new outcome return, and attach `assertHandlerOutcomeMatchesWorld` to every terminal state check. Add three new fixtures: end-to-end re-arm, no-op branch, second-cycle-no-stale-insta-resume.
11. **`PrFeedbackHandler` fixture-only assertion** (FR-009): wrap existing terminal states with `assertHandlerOutcomeMatchesWorld` (mapped from labels + queue state) — no signature change on `PrFeedbackHandler` itself.

## Testing strategy

- **Unit** — `merge-conflict-handler.test.ts` fixtures assert `HandlerOutcome` shape at every terminal branch. Every fixture wraps the terminal snapshot with `assertHandlerOutcomeMatchesWorld` — the load-bearing enforcement half. Q4 → A.
- **Integration** — `merge-conflict-handler.rearm.test.ts` drives the worker's dispatch branch end-to-end: pause labels applied → handler success → worker enqueues `continue` → phase loop re-runs the interrupted phase (assert phase-loop entry, not exit code). The no-op branch fixture drives an identical assertion path with `baseIsAncestor === true`.
- **Regression** — `merge-conflict-handler.second-cycle.test.ts` fires two conflict pauses on the same issue in sequence. The second must hit the handler, not stale-marker-insta-resume through the generic pair path. This is the load-bearing FR-001 test.
- **`PrFeedbackHandler` coverage** — assertion helper attached to every existing terminal-state fixture. No new fixtures; no signature change. FR-009 is assertion-only application.
- **No mock-heavy fake-agent tests** — the agent-invocation step reuses existing test-harness patterns (in-tree mock CLI child); the fix is in the label/queue plane, not the CLI plane.

## Rollout

Ship together in one PR. Reversibility: the change is contained to `packages/orchestrator/src/worker/` (2 files touched, 3 files new) + `packages/orchestrator/src/types/monitor.ts` (1 field added) + `packages/orchestrator/src/worker/phase-loop.ts` (small write insertion before `labelManager.onGateHit`). Reverting removes the new files; existing code unchanged in shape. The sniplink#6/#7/#8 manual repair was applied via labels; once this ship lands, no future issue can dead-park on `MergeConflictHandler` success.

## Complexity Tracking

No constitution violations to justify.
