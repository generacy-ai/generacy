# Feature Specification: MergeConflictHandler success path dead-parks the workflow — clears the pause but never re-arms the phase; leaves agent:in-progress + completed:merge-conflicts residue

**Branch**: `902-found-during-cockpit-v1` | **Date**: 2026-07-10 | **Status**: Draft

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #47. Defect in #898's shipped implementation.

## Observed (christrudelpw/sniplink#6/#7/#8, worker logs)

The #898 `MergeConflictHandler` triggered correctly on the pause state, found the branches already conflict-free (operator had resolved them), and ran its success path:

```
MergeConflictHandler: no-op merge (branch already up to date) — clearing labels
MergeConflictHandler: conflict resolved and pushed   disposition=success
Merge-conflict resolution completed → Worker completed successfully
```

Then nothing, forever. Resulting label state on all three issues: `completed:specify/clarify/plan/tasks` + `agent:in-progress` + `completed:merge-conflicts` — **no `waiting-for:*`, no `failed:*`, no queue item (pending=0, no in-flight)**. No detector matches this state: the pair-path resume needs a `waiting-for`/`completed` pair, #892's re-validate needs `failed:validate`, #891's `resume` needs `failed:*`. The workflow is dead-parked.

## Three sub-defects

1. **The success path never re-arms the interrupted phase.** #898's issue text specified "clears the pause, **and re-arms the phase** (whose pre-merge now succeeds)" — the re-arm is missing. The regression named in the spec ("conflict pause → handler resolves → push → **phase re-runs** → no pause") evidently passes without the phase re-running — the tests-encode-assumptions pattern (ninth occurrence).
2. **`agent:in-progress` left set.** A zombie ownership signal: the auto session (per its dispatch contract) and the operator both read it as "a worker owns this" and waited on a state no worker owns. Handlers must leave agent-status labels truthful on every exit path.
3. **`completed:merge-conflicts` left set.** Latent instant-skip: the *next* time this issue pauses at `waiting-for:merge-conflicts`, the stale completed marker completes the generic resume pair immediately — the monitor resumes before any resolution happens, the phase re-runs into the same conflict, and the pause/insta-resume cycle spins. The handler must consume (remove) the operator-advance marker on completion.

## Fix

On the success path (resolved by agent OR no-op because already resolved), the handler MUST:
- remove `completed:merge-conflicts` (consume the marker) and `agent:in-progress`/`agent:paused` residue;
- **re-arm the interrupted phase** — either apply the resume pair for the gate preceding it (the #891 mapping, derived from workflow config) or directly enqueue a continue item with the correct `startPhase` (in-flight dedupe #879 makes this safe);
- exit with the issue in a state some detector matches. Codify the invariant: **every handler terminal outcome maps to exactly one of: re-armed (queued/pair), gated (`waiting-for:*` present), failed (`failed:*` + evidence), or done (closed/merged)** — "none of the above" is a bug by definition, and a cheap post-exit assertion can enforce it in tests.

## Regression tests (this time asserting the loop, not the handler)

- End-to-end fixture: pause → handler success → **worker re-runs the interrupted phase and it completes** (assert the phase-loop re-entry, not just handler exit code).
- No-op path (branch already resolved): identical re-arm behavior to the resolved-by-agent path.
- Post-handler label snapshot contains no `agent:in-progress`, no `completed:merge-conflicts`, and satisfies the terminal-outcome invariant.
- Second conflict pause after a first successful cycle triggers the handler again (no stale-marker insta-resume).

## Manual repair applied (test cluster)

For #6/#7/#8: removed `agent:in-progress` + `completed:merge-conflicts`, applied the natural-pause resume state (`waiting-for:implementation-review` + `completed:implementation-review` + `agent:paused`, per #891 Q4's indistinguishability rule) so the pair path resumes each into validate on the next poll.

## User Stories

### US1: Merge-conflict handler success path re-arms the interrupted phase

**As an** operator watching cockpit auto-mode,
**I want** the `MergeConflictHandler`'s success path to re-arm the interrupted phase so it re-runs and completes,
**So that** a resolved merge conflict (whether resolved by the agent or already resolved by an operator) does not dead-park the workflow at a state no detector matches. #898's spec promised this re-arm; the implementation missed it, and the auto session stalled indefinitely on #6/#7/#8.

**Acceptance Criteria**:
- [ ] After a successful `MergeConflictHandler` invocation (agent-resolved OR no-op because branch already up-to-date), the interrupted phase re-runs to completion (or pauses at its next natural gate).
- [ ] The re-arm mechanism is either (a) the #891 resume pair (`waiting-for:<preceding-gate>` + `completed:<preceding-gate>` + `agent:paused`) mapped via the workflow config so label-monitor's next poll enqueues a continue item, or (b) direct enqueue of a continue item with the correct `startPhase` (in-flight dedupe from #879 makes either safe).
- [ ] End-to-end regression fixture asserts the phase-loop re-entry, not merely the handler's exit code.

### US2: Handler terminal outcomes are always truthful about ownership

**As an** operator or auto session dispatcher reading label state,
**I want** `agent:in-progress` to reflect actual worker ownership on every handler exit path,
**So that** zombie ownership signals do not cause dispatchers to wait indefinitely on a state no worker owns.

**Acceptance Criteria**:
- [ ] On any `MergeConflictHandler` terminal outcome (success, failure, or bail-out), `agent:in-progress` MUST NOT remain set unless a fresh worker has been dispatched to continue processing the issue.
- [ ] On the success path with re-arm via resume pair: `agent:paused` is applied (matching the natural pause protocol); `agent:in-progress` is removed.
- [ ] On the success path with direct enqueue: labels reflect the queued state (whatever labels the queue path already writes on enqueue); `agent:in-progress` is not left dangling.

### US3: Consumed operator-advance markers do not enable instant-skip on the next pause

**As an** operator whose issue may pause at `waiting-for:merge-conflicts` a second time,
**I want** the previous cycle's `completed:merge-conflicts` marker to be consumed by the handler on success,
**So that** the next pause does not instantly resume through the generic pair-path before any resolution has happened — a loop that would spin the pause/insta-resume cycle and burn credits without progress.

**Acceptance Criteria**:
- [ ] On any `MergeConflictHandler` success path, `completed:merge-conflicts` is removed before the handler exits.
- [ ] Regression fixture: a second conflict pause after a first successful cycle triggers the handler again (no stale-marker insta-resume through the generic pair path).

### US4: Every handler terminal outcome maps to a detector-matching state

**As a** developer of orchestrator handlers,
**I want** the invariant "every handler terminal outcome maps to exactly one of: re-armed / gated / failed / done" codified and enforced in tests,
**So that** "none of the above" states — the dead-park class that produced this bug — are structurally impossible to ship.

**Acceptance Criteria**:
- [ ] The four terminal outcomes are named in shared code (enum, discriminated union, or equivalent) and every handler exit path returns/asserts one of them.
- [ ] A cheap post-exit assertion (available in the test infrastructure) reads the resulting label set and confirms it matches exactly one detector's shape: re-armed (queue item present OR resume pair labels present), gated (`waiting-for:*` present without a stale `completed:<same>`), failed (`failed:*` + evidence), or done (issue closed/merged).
- [ ] The assertion runs in every handler's regression fixtures, not only `MergeConflictHandler`'s.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | On the `MergeConflictHandler` success path (agent-resolved conflict-free committed merge pushed, OR no-op because branch already up-to-date with base), the handler MUST re-arm the interrupted phase such that a worker re-runs it. | P0 | Missed in #898. The whole point of the handler. |
| FR-002 | Re-arm MUST use one of: (a) the #891 resume pair — apply `waiting-for:<preceding-gate>` + `completed:<preceding-gate>` + `agent:paused`, gate name derived from the workflow config's inverted gate mapping for the interrupted phase, so label-monitor's next poll enqueues a continue item; or (b) direct enqueue of a continue item with the correct `startPhase` (in-flight dedupe from #879 makes either safe). Choice of mechanism is an implementation detail; the observable outcome is that the phase re-runs. | P0 | Both mechanisms exist in the codebase (#891 pair, #879 dedupe); implementation picks whichever is cleanest. |
| FR-003 | On the success path, `completed:merge-conflicts` MUST be removed before the handler exits. The label is an operator-advance marker; leaving it set enables a stale insta-skip on the next pause at `waiting-for:merge-conflicts`. | P0 | Sub-defect 3. |
| FR-004 | On the success path, `agent:in-progress` MUST NOT remain set unless a fresh worker has been dispatched. When re-arm uses the resume pair, apply `agent:paused` and remove `agent:in-progress`. When re-arm uses direct enqueue, follow whatever labels the queue path writes on enqueue. | P0 | Sub-defect 2. |
| FR-005 | The handler MUST codify the terminal-outcome invariant: every exit path maps to exactly one of {re-armed, gated, failed, done}. The four outcomes SHOULD be named in shared code (enum or discriminated union) reachable from every handler in the orchestrator, not only `MergeConflictHandler`. | P1 | Structural fix — makes the "none of the above" dead-park class impossible to ship. |
| FR-006 | A cheap post-exit assertion helper MUST be available in the test infrastructure that reads the resulting label set (plus queue state, if reachable) and confirms it matches exactly one of the four detector shapes: re-armed (queue item present OR resume pair labels present), gated (`waiting-for:*` present without a stale `completed:<same>`), failed (`failed:*` + evidence), or done (issue closed/merged). | P1 | Enforces FR-005 in regression fixtures. |
| FR-007 | Regression fixture: end-to-end pause → `MergeConflictHandler` success (agent-resolved) → the interrupted phase re-runs and completes (or pauses at its next natural gate). Assertion is on phase-loop re-entry, not merely handler exit code. | P0 | Directly addresses the tests-encode-assumptions failure mode named in the issue. |
| FR-008 | Regression fixture: no-op success path (branch already conflict-free at handler entry) exhibits identical re-arm behavior to the agent-resolved path. | P0 | The observed defect entered via this path (#6/#7/#8: operator resolved first). |
| FR-009 | Regression fixture: post-`MergeConflictHandler`-success label snapshot contains no `agent:in-progress`, no `completed:merge-conflicts`, and satisfies FR-006's terminal-outcome invariant. | P0 | Directly asserts sub-defects 2 and 3. |
| FR-010 | Regression fixture: a second conflict pause at `waiting-for:merge-conflicts` after a first successful cycle triggers the handler again (no stale-marker insta-resume through the generic pair path). | P0 | Directly asserts sub-defect 3's consequence. |
| FR-011 | The FR-006 post-exit assertion SHOULD be applied to the regression fixtures of every existing handler in `packages/orchestrator/src/worker/` (`PrFeedbackHandler`, and any others that write labels on exit) to catch the same class of dead-park bug in siblings. | P2 | Prophylactic; scope this to what's cheap. Discovery of a sibling bug via this assertion is a separate follow-up, not blocking this issue. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Issues at `completed:merge-conflicts` + `agent:in-progress` (no `waiting-for:*`, no `failed:*`, no in-flight queue item) for > 5 minutes post handler success. | 0 | Per auto-mode run, scan issue label state at run end; count issues in this dead-park shape. |
| SC-002 | Successful `MergeConflictHandler` invocations (agent-resolved or no-op) that result in the interrupted phase re-running. | 100% | Regression fixture: run the E2E pause → resolve → re-run flow; assert phase-loop re-entry. |
| SC-003 | Second `waiting-for:merge-conflicts` pauses in a session that trigger the handler (not instant-skip through the generic pair path). | 100% | Regression fixture: two pause/resolve cycles on the same issue; assert handler invoked on both. |
| SC-004 | `MergeConflictHandler` exit paths that map to exactly one of {re-armed, gated, failed, done}. | 100% | Post-exit assertion (FR-006) runs in every handler regression fixture and passes. |
| SC-005 | Zombie `agent:in-progress` labels persisting on issues with no dispatched worker. | 0 | Snapshot in regression fixtures; scan-and-count in production auto-mode runs. |

## Assumptions

- The #891 resume-pair mechanism (`waiting-for:<gate>` + `completed:<gate>` + `agent:paused` triggers label-monitor to enqueue a continue item) is the established primitive for re-arming from a paused state and is directly reusable here. The inverted gate mapping (`resolvePrecedingGate` from `packages/generacy/src/cli/commands/cockpit/gate-vocabulary.ts`, or its orchestrator-side equivalent) determines the correct preceding gate for the interrupted phase.
- The #879 in-flight dedupe protects against duplicate work if the handler re-arms via direct enqueue and the label-monitor also observes the state (webhook+poll races collapse).
- `MergeConflictHandler` has enough context (interrupted phase identity, workflow config) at its success exit point to derive the correct re-arm state. If it doesn't, that plumbing (threading `phase` through to the handler) is in scope for this fix.
- The dead-park state observed on #6/#7/#8 (`completed:specify/clarify/plan/tasks` + `agent:in-progress` + `completed:merge-conflicts` + no `waiting-for:*` / `failed:*` / queue item) is exhaustively described by the three sub-defects listed; no fourth latent problem is hiding in this label shape.
- The tests-encode-assumptions failure mode named in the issue (regression named in #898 evidently passed without the phase re-running) is addressed by asserting phase-loop re-entry (FR-007), not merely handler exit code. The existing regression is expected to be updated in place, not merely supplemented.
- Handlers other than `MergeConflictHandler` (e.g. `PrFeedbackHandler`) may already satisfy the terminal-outcome invariant; the FR-011 prophylactic scan is scoped to running the FR-006 assertion against their existing fixtures, not rewriting their behavior.

## Out of Scope

- **Changes to `waiting-for:merge-conflicts` semantics or the pre-phase base-merge in #864.** This spec builds on #898/#864 as shipped; only the success-path re-arm is in scope.
- **Rewriting `PrFeedbackHandler` or other handlers.** FR-011 applies the FR-006 assertion to their fixtures; if a sibling handler fails the assertion, the fix is a follow-up issue, not blocking this one.
- **Cockpit CLI verb changes.** The manual repair on #6/#7/#8 used existing label surgery; no new verb is required. (If auto-mode discovers a recurring class of manual repair, that's a separate spec — see also #891's `resume` verb, which is orthogonal.)
- **Multi-attempt agent resolution or escalation flows beyond #898's one-attempt discipline.** The fix is at the *end* of the success path; the attempt-scoping from #898 FR-004 is unchanged.
- **Cross-repo / linked-PR coordination on merge conflicts.** #898's FR-005 sibling scope guard is unchanged; this spec fixes only the terminal state, not the resolution behavior.
- **Retroactively cleaning up existing dead-parked issues in production.** The manual repair described in the issue body is one-shot operator work; this spec makes the class of bug not recur, not sweep existing residue.

---

*Generated by speckit*
