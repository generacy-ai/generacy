# Feature Specification: Re-validate on Base Advance + Bounded Validate-Fix Cycle

**Branch**: `892-found-during-cockpit-v1` | **Date**: 2026-07-09 | **Status**: Draft
**Source**: [generacy-ai/generacy#892](https://github.com/generacy-ai/generacy/issues/892)

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #43 — the design gap behind three P2 issues stranding at `failed:validate`, and the answer to the operator's question "perhaps we need something to request changes when validate fails?"

The orchestrator does not distinguish between **integration reds** (an import fails because a sibling's file hasn't merged yet) and **genuine code reds** (a real defect on the branch). Currently, both fall into `failed:validate` and neither is retriable: nothing re-triggers validate when the base branch advances, so integration reds are permanent, and there is no bounded fixer for genuine reds. Auto-mode epics with cross-dependent siblings deadlock.

## Confirmed Mechanism (Empirical, Not Theorized)

`christrudelpw/sniplink#8`'s validate red reproduces exactly: `next build` type-check fails with `Cannot find module '@/components/CopyButton'` — `CopyButton` is created by sibling #7, per the epic's own working convention ("where two issues share a component, one *creates* it and the other *reuses* it"). At validate time no sibling had merged, so the merge-preview (#864, confirmed present in the validate path) equaled the branch tip, and the import could not resolve. The same tree validates green the moment #7 is in main: re-running #6's validate on today's merge-preview passes 34/34 tests + build.

So this red class is **not a code defect and not agent-fixable**: an agent "requesting changes" on #8's branch cannot conjure #7's component — its best case is a no-op and its worst case is *duplicating the sibling's file*, manufacturing the very conflict the file-disjoint convention prevents. Nothing re-triggers validate when main advances, so the reds are permanent: the phase deadlocks with the dependency sitting un-merged behind a red of its own, and an auto run can never reach phase-complete.

## Proposal — Split by Red Class

### (a) Re-validate on Base Advance

When the epic's base branch advances (a sibling merges), automatically resume every epic issue sitting at `failed:validate` (via the `cockpit resume` verb, filed separately). Their merge-preview has changed, so the red is stale evidence.

- **Idempotency key**: one re-validate per `(issue, new base SHA)` — the queue's in-flight dedupe (#879) already collapses storms.
- **Convergence property**: dependency-ordered merges unlock dependents' re-validates one merge at a time, with no explicit ordering machinery — #7 merges → #8 re-validates green → #8 merges.

### (b) Bounded Validate-Fix Cycle

A red that *persists on a fresh merge-preview* is a real defect. Mirror the merge-fixer/PR-feedback shape:

- One autonomous agent attempt on the branch with the failure evidence (stdout-inclusive, per the evidence finding).
- Apply #883 termination discipline: the attempt must change the tree or stop.
- Re-validate after push; still red → `failed:validate` + alert + human escalation (auto mode's existing gate).
- One autonomous attempt per distinct red (evidence hash); further attempts only via the escalation gate — same "the gate is the bound" rule as agency#392 Q3.

**Ordering constraint**: (a) must run before (b) is judged — a fix cycle should only ever fire on a red that survived a current-base re-validate, or the agent will "fix" phantom integration reds.

## User Stories

### US1: Cross-Dependent Siblings Converge Without Human Intervention

**As an** operator running auto-mode on an epic with cross-dependent siblings,
**I want** stuck `failed:validate` issues to automatically re-validate when their base advances,
**So that** dependency-ordered merges cascade naturally without me manually re-queuing every stranded issue.

**Acceptance Criteria**:
- [ ] Sibling merge → every epic issue at `failed:validate` re-arms exactly once for the new base SHA.
- [ ] Re-validate that goes green transitions to `completed:validate` without agent involvement.
- [ ] Idempotency key `(issue, new base SHA)` prevents duplicate re-validate runs.
- [ ] Cascade converges: three cross-dependent siblings queued in parallel reach all-merged with no human action beyond existing gates.

### US2: Bounded Fix Attempts on Genuine Reds

**As an** operator,
**I want** the orchestrator to attempt exactly one autonomous fix on a genuine (non-integration) red before escalating,
**So that** real defects get a chance at self-repair but the system cannot loop indefinitely on unfixable failures.

**Acceptance Criteria**:
- [ ] Red persists on fresh merge-preview → exactly one fix-cycle attempt.
- [ ] Fix attempt that changes the tree → push → re-validate.
- [ ] Fix attempt that leaves tree unchanged → no retry; escalation via existing `failed:validate` gate.
- [ ] Further attempts on the same evidence hash require the human escalation gate.

### US3: Guard Against Sibling File Duplication

**As an** operator,
**I want** the fix cycle to never create a file that exists on any open sibling branch of the same phase,
**So that** the agent cannot manufacture the merge conflict the file-disjoint convention prevents.

**Acceptance Criteria**:
- [ ] Fix attempt aborts if it would create a file present on an open sibling branch of the same phase.
- [ ] Guard uses the epic's sibling PR graph, not just merged/main state.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | On epic base-branch advance (sibling merged), enumerate all epic issues currently at `failed:validate` and enqueue a re-validate for each. | P1 | Triggered by merge event, not polling. |
| FR-002 | Idempotency: at most one re-validate per `(issue, new base SHA)` pair. | P1 | Reuse #879 in-flight dedupe; add a persisted `(issue, base-SHA)` key. |
| FR-003 | Re-validate uses the current merge-preview (per #864), not the historical branch tip. | P1 | Merge-preview must be recomputed against advanced base. |
| FR-004 | On a validate red that persists on a fresh merge-preview, launch exactly one autonomous fix-cycle attempt. | P1 | Evidence-hash keyed. |
| FR-005 | Fix-cycle attempt must include full failure evidence (stdout-inclusive) in the agent prompt. | P1 | Per the evidence finding referenced in the issue. |
| FR-006 | Fix-cycle attempt must terminate if it produces no tree change (#883 termination discipline). | P1 | Same rule as merge-fixer / PR-feedback. |
| FR-007 | After a tree-changing push in the fix cycle, re-validate is triggered. | P1 | |
| FR-008 | Persistent red after fix-cycle attempt → apply `failed:validate` + alert + human escalation gate. | P1 | Existing gate behavior. |
| FR-009 | Second autonomous attempt on the same evidence hash is blocked; only the human escalation gate can release it. | P1 | "The gate is the bound" (agency#392 Q3). |
| FR-010 | (a) precedes (b): the fix cycle only fires on a red that survived a current-base re-validate. | P1 | Ordering constraint. |
| FR-011 | Fix cycle refuses to create a file that exists on any open sibling PR branch of the same phase. | P1 | Sibling-duplication guard. |
| FR-012 | Emit structured event on each re-validate trigger and each fix-cycle attempt for observability. | P2 | Enables auto-mode telemetry. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Cross-dependent sibling epic convergence without human intervention | 3 siblings → all merged, 0 human actions beyond gates | Reproduce sniplink#6/#7/#8 scenario end-to-end in auto-mode. |
| SC-002 | Duplicate re-validate suppression | 0 duplicate runs per `(issue, base SHA)` | Trigger repeated sibling merges rapidly; count validate runs. |
| SC-003 | Bounded fix attempts on persistent reds | Exactly 1 autonomous attempt per evidence hash | Inject a persistent code red; count fix-cycle spawns. |
| SC-004 | No phantom integration-red fixes | 0 fix-cycle attempts on reds that would resolve on current base | Instrument fix-cycle spawn; verify preconditions. |
| SC-005 | No sibling file duplication | 0 fix-cycle pushes creating a file on an open sibling PR of same phase | Static pre-push guard trip counter. |

## Regression Tests

- **Sibling merge unblocks stuck issue**: sibling merge → stuck `failed:validate` issues in the same epic re-arm exactly once for the new base SHA; green preview → `completed:validate` without agent involvement.
- **Bounded fix-cycle**: red persisting on fresh preview → exactly one fix-cycle attempt; tree-changing push → re-validate; unchanged tree → no retry, escalation.
- **Sibling duplication guard**: fix cycle never creates a file that exists on any open sibling branch of the same phase.
- **End-to-end convergence**: three cross-dependent siblings queued in parallel converge to all-merged with no human action beyond existing gates.

## Assumptions

- The epic's base branch (usually `develop` or the epic base) is discoverable from the issue's epic linkage.
- Merge-preview computation (#864) is already integrated into the validate path.
- The `cockpit resume` verb (filed separately) exists and can be triggered programmatically by the base-advance event.
- Queue in-flight dedupe (#879) is available for storm collapse.
- The `#883` termination-discipline pattern (tree-change-or-stop) is reusable for the fix cycle.
- Auto-mode's existing `failed:validate` gate handles alert + human escalation.

## Out of Scope

- The `cockpit resume` verb itself (filed separately).
- Merge-preview infrastructure (#864, already present).
- Queue in-flight dedupe (#879, already present).
- Termination-discipline machinery (#883, reused as-is).
- Changes to the human escalation gate.
- Cross-epic dependency handling (this feature is single-epic scoped).

## Open Questions

- Which orchestrator service owns the base-advance listener? (Likely `LabelMonitorService` or a new service parallel to it.)
- Where is the `(issue, base SHA)` idempotency key persisted? (Redis via `PhaseTrackerService`? A new key namespace?)
- What is the exact evidence-hash canonicalization? (Test-runner output? stderr? A stable digest excluding timestamps?)
- Does the sibling-duplication guard use `gh pr diff` per open sibling PR, or a pre-computed manifest maintained by the queue?

---

*Generated by speckit*
