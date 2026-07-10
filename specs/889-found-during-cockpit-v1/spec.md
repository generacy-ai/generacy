# Feature Specification: orchestrator — `waiting-for:merge-conflicts` label never provisioned, and label-op failure crash-loops the worker

**Branch**: `889-found-during-cockpit-v1` | **Date**: 2026-07-09 | **Status**: Draft | **Issue**: [#889](https://github.com/generacy-ai/generacy/issues/889)

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92, finding #40).

Re-claims of `christrudelpw/sniplink#6` and `#7` hit #864's pre-implement base-merge, which correctly detected a `CLAUDE.md` conflict and took the pause path — then crashed while trying to apply the pause labels:

```
Gate hit: … adding waiting-for:merge-conflicts and agent:paused
Label operation failed (attempt 1/3) … 'waiting-for:merge-conflicts' not found
Label operation failed (attempt 2/3) …
Label operation failed after 3 attempts
Worker encountered an unhandled error
Worker failed, item released back to queue
```

Two independent defects compose the observed crash-loop:

1. **`waiting-for:merge-conflicts` was never provisioned in the target repos.** #864 added the label to the protocol (see `packages/workflow-engine/src/actions/github/label-definitions.ts:36-42` — the label is *missing* from `WORKFLOW_LABELS`), but nothing writes it into repos that were provisioned before #864 landed. `gh issue edit --add-label <name>` hard-fails when the label doesn't exist (`packages/workflow-engine/src/actions/github/client/gh-cli.ts:779-791`), so the pause path fails on every pre-existing repo.
2. **A label-op failure crash-loops the worker.** After the 3-attempt backoff in `LabelManager.retryWithBackoff` (`packages/orchestrator/src/worker/label-manager.ts:241-269`), the error propagates unhandled through `PhaseLoop.pausePreMergeConflict` → `PhaseLoop.executeLoop` → `ClaudeCliWorker.processItem` (`claude-cli-worker.ts:643-668` re-throws), which causes `WorkerDispatcher` to release the item back to the queue (`services/worker-dispatcher.ts:353`). The next worker re-claims, re-runs base-merge, hits the same conflict, hits the same missing label, and releases again — the item cycles through workers indefinitely until an operator intervenes.

Both defects generalize beyond `waiting-for:merge-conflicts`: any future protocol-vocabulary addition would hit defect (1), and any GitHub metadata blip would hit defect (2).

## User Stories

### US1: Pause path succeeds on repos that predate a new protocol label

**As** an operator running the cockpit workflow against repos provisioned before a new `waiting-for:<gate>` label was added to the protocol,
**I want** the phase loop to still be able to pause at that gate,
**So that** rolling out a new gate label does not require me to sweep every downstream repo before the next queue drains.

**Acceptance Criteria**:
- [ ] Given a repo that has none of the `waiting-for:merge-conflicts` label, when the pre-implement base-merge (#864) detects a conflict, the workflow pauses successfully (`waiting-for:merge-conflicts` and `agent:paused` land on the issue).
- [ ] The fix generalizes — every label the orchestrator can apply from `WORKFLOW_LABELS` (or any future protocol addition) is either present on the target repo before it is applied, or is created on demand.
- [ ] No manual `gh label create` step is required by the operator before or after the fix ships.

### US2: A GitHub metadata failure fails the item, not the worker

**As** an operator watching the queue during the failure mode above (or any transient GitHub API issue),
**I want** a label-application failure to fail the *individual issue*, not release it back into the queue for another worker to re-claim,
**So that** one bad item cannot crash-loop the fleet and starve every other item behind it.

**Acceptance Criteria**:
- [ ] When `LabelManager` exhausts its 3-attempt retry, the item is marked failed (`agent:error` applied via the existing `LabelManager.onError` path *or* an equivalent terminal state) and left in place — it is NOT released back to `pending`.
- [ ] The worker itself continues processing other items after the failure — no unhandled throw escapes `ClaudeCliWorker.processItem` for this class of error.
- [ ] The failure produces a `#865`-style alert comment (or the currently active failure-alert channel) that names the label operation and includes the underlying `gh` error text as evidence, so an operator can diagnose without reading worker logs.

### US3: Drift between the protocol vocabulary and the provisioning set is caught

**As** a developer landing the next protocol-label addition (post-#889),
**I want** the CI / test suite to fail if I add a label to the engine's vocabulary without adding it to the provisioning set,
**So that** #889 does not recur every time we extend the protocol.

**Acceptance Criteria**:
- [ ] A test asserts that every label symbol the engine can apply appears in `WORKFLOW_LABELS` (or the equivalent provisioning source of truth).
- [ ] The test fails today (before the fix) for `waiting-for:merge-conflicts` and passes after the fix.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `waiting-for:merge-conflicts` is added to `WORKFLOW_LABELS` in `packages/workflow-engine/src/actions/github/label-definitions.ts` (color/description matching sibling `waiting-for:*` entries: `FBCA04`, `"Waiting for base-merge conflict resolution"` or similar). | P1 | Direct fix for the observed omission. |
| FR-002 | Before any `addLabels(...)` call from the phase loop's label boundary, the target repo is confirmed to have the labels via a **two-tier mechanism** (see Q1): (a) `LabelSyncService` continues syncing on repo-add / worker boot as a fast-convergence latency optimization, AND (b) `LabelManager` gains a load-bearing create-if-missing pass at the boundary, memoized per `(process, repo)` so the ensure-pass runs once per repo per process lifetime, not per call. Tests target the boundary net (b); the proactive sync (a) is not the safety property. | P1 | Prevents recurrence for every future protocol addition without requiring a #889-style hotfix. |
| FR-003 | When `LabelManager` exhausts its 3-attempt retry inside **any of the four sites — `onGateHit`, `onPhaseStart`, `onPhaseComplete`, `onError` — uniformly** (see Q4), the phase loop does NOT re-throw out of `ClaudeCliWorker.processItem`. Instead, `processItem` returns a **discriminated result** (see Q2) — e.g., `{ status: 'failed-terminal', failureMetadata: { site, labelOp, ghStderr } }` — that `WorkerDispatcher` branches on: `'failed-terminal'` marks the item completed-with-failure (NOT released), `'released'` retains today's release behavior. The failing site (`gate-hit` / `phase-start` / `phase-complete` / `error`) is carried as structured metadata for the queue/telemetry. | P1 | Direct fix for the observed crash-loop. |
| FR-004 | The failure surface for FR-003 is emitted by `WorkerDispatcher` (the single authority — see Q2) as a #865-style alert comment on the issue that names the failed label operation (`onGateHit(implement, waiting-for:merge-conflicts)`), the boundary site, and includes the `gh` stderr as evidence. The `agent:error` label add is **best-effort** (see Q3) — wrapped in try/catch, individual failures logged at `warn`. The alert comment is the **authoritative failure surface**; if the comment *also* fails, emit a structured `error`-level log with full context, but still no re-throw and no release. | P2 | Operator-facing diagnosability; parallel to the #865/#847 evidence contracts. |
| FR-005 | A regression test asserts that on a repo lacking `waiting-for:merge-conflicts`, a base-merge conflict pauses successfully (label created at the boundary net before add). | P1 | Locks in FR-001+FR-002. |
| FR-006 | A regression test asserts that a mocked hard failure of `addLabels` after 3 retries fails the item gracefully: `processItem` returns `{ status: 'failed-terminal', ... }`, the dispatcher does NOT release, `agent:error` is attempted best-effort, the alert comment fires, and the worker continues to next item. | P1 | Locks in FR-003. |
| FR-007 | A drift/audit test enumerates every label symbol the orchestrator applies (`phase:*`, `completed:*`, `waiting-for:*`, `failed:*`, `agent:*`) via a **hybrid enumeration** (see Q5): (a) load-bearing static AST/grep walk over `packages/orchestrator/**` and `packages/workflow-engine/**` for string literals matching `^(phase\|completed\|waiting-for\|failed\|agent):`, asserting each ⊆ `WORKFLOW_LABELS.map(l => l.name)`; (b) a secondary runtime-registry smoke on the phase-loop's hot boundary that also validates the FR-002 memoized ensure-pass. | P1 | Locks in US3; prevents the class of bug from recurring. |
| FR-008 | The fix is idempotent and does not alter the behavior of `LabelManager` on the happy path (existing tests pass unchanged). | P1 | Non-regression. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Missing-label crash-loop reproduces on `develop`; does not reproduce after the fix. | 0 crash-loops observed on the regression scenario. | Manual repro of the #889 scenario (or the test fixture standing in for it) before/after the fix. |
| SC-002 | Every `waiting-for:*` label emitted by `phase-loop.ts` or `label-manager.ts` appears in `WORKFLOW_LABELS`. | 100% coverage (audit test green). | FR-007 test. |
| SC-003 | Label-op hard failure after retries fails the item, not the worker. | Worker keeps processing the next queued item within one poll interval after the failed item; failed item is NOT released back to `pending`. | FR-006 test + optionally a queue-adapter assertion (release-not-called). |
| SC-004 | Zero code changes required to add a future `waiting-for:*` label beyond appending to `WORKFLOW_LABELS`. | Adding a new symbol requires no `LabelManager` changes and no per-repo migration. | Structural — verified by the FR-002 mechanism (create-if-missing OR proactive sync). |

## Assumptions

- The failure alert channel (`agent:error` + #865-style comment) is the appropriate terminal state for a label failure. If #865 has been superseded by a newer alert contract (`specs/865-found-during-cockpit-v1/`), FR-004 targets whatever contract is current on `develop` at implementation time.
- `LabelSyncService` (`packages/orchestrator/src/services/label-sync-service.ts`) is the right home for the proactive-sync half of FR-002 if that route is chosen — it already tracks per-repo sync state and is called on repo-add.
- `gh label create --force` (used at the reactive create-if-missing boundary, if chosen) is idempotent and safe to call under concurrent workers on the same repo.
- The worker dispatcher's release/complete distinction (`services/worker-dispatcher.ts`) is the correct control point for FR-003 — an item that reached a terminal failed state should be completed-with-failure, not released.

## Out of Scope

- Retroactive backfill of labels on already-provisioned repos via a one-off script (the fix is either "create-on-demand" or "proactive sync on next touch"; a manual sweep is not required).
- Changes to the base-merge behavior itself (#864 is the source of truth for the pause protocol; #889 only fixes the label plumbing and error handling around it).
- Broader failure-alert taxonomy changes (#865 evidence-block contract is reused as-is).
- Retry-policy tuning beyond the existing 3-attempt exponential backoff — the fix is about *what happens after* the retry is exhausted, not the retry itself.
- New `waiting-for:*` gates beyond `waiting-for:merge-conflicts`. Audit test (FR-007) covers the *class* of bug; other missing labels (if any) are fixed by satisfying the audit.

---

*Generated by speckit for issue #889*
