# Feature Specification: Found during the cockpit v1

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
- **re-arm the interrupted phase** by returning a terminal outcome `{outcome: 're-armed', startPhase}` to the dispatcher; the **dispatcher** (single authority per #889 Q2-D) completes the handler's own claim, then enqueues the `continue` item with the correct `startPhase`. The handler itself never touches the queue — its item is still claimed at success-path time, so a handler-side `enqueueIfAbsent` would self-deadlock against #879's single-in-flight rule (Q1);
- source `startPhase` from `ResolveMergeConflictsMetadata.phase`, threaded in-band from the phase-loop pause site (Q2). If metadata is missing, **fail loud** with evidence per the #889 terminal path — never re-derive from labels (the protocol writes no `completed:implement` marker after an `implementation-review` pair is consumed, so label-derivation is a wrong-answer generator);
- exit with the issue in a state some detector matches. Codify the invariant: **every handler terminal outcome maps to exactly one of: re-armed (queued), gated (`waiting-for:*` present), failed (`failed:*` + evidence), or done (closed/merged)** — "none of the above" is a bug by definition, and a post-exit runtime assertion (reading the *real* label set + queue state, not the handler's own return value) enforces it in tests.

## Regression tests (this time asserting the loop, not the handler)

- End-to-end fixture: pause → handler success → **worker re-runs the interrupted phase and it completes** (assert the phase-loop re-entry, not just handler exit code).
- No-op path (branch already resolved): identical re-arm behavior to the resolved-by-agent path.
- Post-handler label snapshot contains no `agent:in-progress`, no `completed:merge-conflicts`, and satisfies the terminal-outcome invariant.
- Second conflict pause after a first successful cycle triggers the handler again (no stale-marker insta-resume).

## Manual repair applied (test cluster)

For #6/#7/#8: removed `agent:in-progress` + `completed:merge-conflicts`, applied the natural-pause resume state (`waiting-for:implementation-review` + `completed:implementation-review` + `agent:paused`, per #891 Q4's indistinguishability rule) so the pair path resumes each into validate on the next poll.


## User Stories

### US1: Auto-mode conflict pause self-resolves without dead-parking

**As an** auto-mode operator watching cockpit,
**I want** a `waiting-for:merge-conflicts` pause that resolves (by the handler OR because the branch is already clean) to re-arm the interrupted phase automatically,
**So that** the workflow re-enters the phase loop on the same tick — no zombie `agent:in-progress`, no stale `completed:merge-conflicts`, no need for the manual repair applied to sniplink#6/#7/#8.

**Acceptance Criteria**:
- [ ] After `MergeConflictHandler` returns success, the next label snapshot on the issue has no `agent:in-progress` and no `completed:merge-conflicts`.
- [ ] The worker picks the issue back up and the interrupted phase runs to completion (or the next natural pause) — the phase-loop re-entry is observable in worker logs, not merely inferred from handler exit code.
- [ ] The no-op branch (branch was already conflict-free at handler entry) produces identical downstream state to the resolved-by-agent branch.
- [ ] A second conflict pause after a first successful cycle triggers the handler again — no stale-marker insta-resume.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | On the `MergeConflictHandler` success path (agent-resolved or no-op), the handler MUST remove `completed:merge-conflicts` and `agent:in-progress` from the issue. | P1 | Handler-side; consumes operator-advance marker. |
| FR-002 | The handler MUST return a terminal outcome `{outcome: 're-armed', startPhase}` to the dispatcher; the dispatcher (single queue authority per #889 Q2-D) completes the handler's claim and enqueues a `continue` item with `startPhase`. Handler MUST NOT call the queue directly. | P1 | Q1 = B (direct enqueue, at the dispatcher). Avoids self-deadlock against #879's single-in-flight rule. |
| FR-003 | `ResolveMergeConflictsMetadata` MUST carry a `phase: WorkflowPhase` field, populated at the pause site in the phase loop. The handler reads `startPhase` from this field. | P1 | Q2 = A. In-band, canonical, one point of truth. |
| FR-004 | If `ResolveMergeConflictsMetadata.phase` is missing at handler exit, the handler MUST fail loud with evidence per the #889 terminal path — MUST NOT re-derive `startPhase` from the issue's `completed:<phase>` labels. | P1 | Q2 rejects B/C. Label-derivation is a wrong-answer generator after an `implementation-review` pair has been consumed. |
| FR-005 | A discriminated-union `HandlerOutcome` type (`re-armed | gated | failed | done`) MUST live in `packages/orchestrator/src/worker/` and be the return type of `MergeConflictHandler.handle`. | P1 | Q4 = A. Orchestrator-local until a second package needs it (YAGNI on `@generacy-ai/workflow-engine`). |
| FR-006 | A post-exit runtime assertion helper MUST verify the actual label set + queue state matches the returned `HandlerOutcome`. This is the **load-bearing** enforcement half — the type alone cannot catch this bug class (compile-time exhaustiveness would have passed the broken handler). | P1 | Q4. Reads the world, not the handler's claim. |
| FR-007 | Label mutations on the ownership transition MUST use a single combined `gh issue edit --add-label … --remove-label …` invocation. Where calls must split, add-before-remove ordering applies (per #849's paired-clear reasoning). | P1 | Q5 favours option C's shape; A applies as fallback. B is disqualified. |
| FR-008 | The dispatcher MUST enqueue the `continue` item **before** any label cleanup on the issue. A crash after enqueue leaves stale pause labels (harmlessly removed by the worker's existing resume-cleanup, shielded from double-fire by in-flight dedupe); a crash before enqueue leaves the pause state intact and re-triggerable. Never both cleared. | P1 | Q5 invariant: every intermediate state must be detector-matched or over-labelled, never under-labelled. |
| FR-009 | The terminal-outcome invariant (re-armed | gated | failed | done) applies to every handler exit path. `PrFeedbackHandler` gains fixture-level assertion coverage in this issue — no rewrite. | P2 | FR-011 in prior draft; renumbered. Assertion-only application. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Post-handler dead-park rate on `MergeConflictHandler` success path | 0 across the end-to-end + no-op regression fixtures | Regression suite asserts label snapshot + queue state via FR-006 helper. |
| SC-002 | Phase re-entry latency after handler success | Same tick (no poll-cycle wait) | Worker log shows phase-loop entry with correct `startPhase` immediately following dispatcher enqueue. |
| SC-003 | Second-conflict cycle correctness | Second pause triggers handler again (no insta-resume) | Regression fixture: two conflicts on the same issue, each hits the handler; no stale-marker fast-path fires between them. |
| SC-004 | No regression in existing paused/gated/failed/done paths for `MergeConflictHandler` and `PrFeedbackHandler` | 100% of existing fixtures pass with FR-006 assertion attached | Fixture snapshot diffs. |

## Assumptions

- The phase-loop pause site already knows the interrupted phase (`phase: WorkflowPhase` is in scope at the point `waiting-for:merge-conflicts` is applied). Threading it into `ResolveMergeConflictsMetadata` is a small plumbing change, not a new lookup.
- The dispatcher is the single queue-transition authority per #889 Q2-D, and #879's single-in-flight dedupe is trusted to collapse any label-monitor/webhook race the dispatcher-side enqueue creates.
- The worker's existing resume-cleanup handles stale pause labels harmlessly when a `continue` item arrives with the labels still present (crash-after-enqueue path).
- `PrFeedbackHandler` is the only other handler in scope for FR-009's assertion-only application; future handlers are out of scope.

## Out of Scope

- Extracting `resolvePrecedingGate` / preceding-gate mapping into a shared package (Q3 = N/A under Q1-B; do this only when a real second consumer appears).
- Moving `HandlerOutcome` to `@generacy-ai/workflow-engine` (YAGNI until a non-orchestrator handler exists).
- Any resume-pair (label-plane) rewrite of the handler's re-arm path — direct enqueue is canonical here.
- Retrofitting `PrFeedbackHandler` to return a `HandlerOutcome` (FR-009 is assertion-only — no handler signature change).
- Broader "every handler" invariant sweep beyond `MergeConflictHandler` + `PrFeedbackHandler`.

---

*Generated by speckit*
