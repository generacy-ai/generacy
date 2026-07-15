# Feature Specification: Cockpit classifier — `blocked:*` error tier

**Branch**: `943-summary-blocked-stuck-merge` | **Date**: 2026-07-15 | **Status**: Draft
**Source**: [#943](https://github.com/generacy-ai/generacy/issues/943)

## Summary

`blocked:stuck-merge-conflicts` — applied by the orchestrator's merge-conflict handler when its one autonomous remedy attempt gives up ([`merge-conflict-handler.ts`](../../packages/orchestrator/src/worker/merge-conflict-handler.ts): *"On block: apply `blocked:stuck-merge-conflicts`, leave `waiting-for` in place"*) — does not have a dedicated tier in the cockpit classifier's state model. It is present in `WORKFLOW_LABELS` and today falls into the generic `waiting` tier via the `blocked:*` pattern branch in `packages/cockpit/src/state/label-map.ts:36-39`, alongside `waiting-for:merge-conflicts`. Because `waiting-for:merge-conflicts` is not itself listed in `WAITING_PIPELINE_ORDER`, the tie-break between the two labels is unstable / non-obvious and the specific *blocked* signal is not surfaced as a distinguishable state.

Downstream, the `cockpit:auto` skill's dispatch table does not carry a rule keyed on this pause. During the snappoll dogfood run this produced **3 unrecognized-state escalations**, each interrupting the operator with a generic "never guess" gate instead of dispatching to the existing merge-conflicts escalation gate that already handles `waiting-for:merge-conflicts`.

## Evidence

- snappoll#3: `blocked:stuck-merge-conflicts` labeled 2026-07-14T22:41:44Z (alongside `waiting-for:merge-conflicts` from 22:39:39), unlabeled 23:03:32.
- snappoll#13: same pattern on 2026-07-15 (~15:01), resolved via operator `merge-conflicts` advance + `cockpit_resume`.
- Run summary: *"Escalations: 3 unrecognized-state (`blocked:stuck-merge-conflicts`)"*.
- Label origin: `packages/orchestrator/src/worker/merge-conflict-handler.ts` / `merge-conflict-remedy.ts` (feature #898).
- Cluster: `snappoll-local-1`, stable, orchestrator 0.8.0.

## User Stories

### US1 — Operator running cockpit:auto sees blocked-state escalation routed to the right gate

**As an** operator running `cockpit:auto` against an epic,
**I want** `blocked:stuck-merge-conflicts` to be classified as an error-tier state whose `sourceLabel` is the blocked label itself,
**So that** the auto skill dispatches to the specific merge-conflicts escalation gate (which already knows how to instruct me to resolve conflicts, remove `blocked:*`, and cockpit-resume) instead of interrupting me with the generic "never guess" unrecognized-state gate.

**Acceptance Criteria**:
- [ ] `classify(['waiting-for:merge-conflicts', 'blocked:stuck-merge-conflicts'])` returns `{ state: 'error', sourceLabel: 'blocked:stuck-merge-conflicts' }`.
- [ ] `blocked:stuck-merge-conflicts` outranks `waiting-for:merge-conflicts` deterministically (not by accident of WORKFLOW_LABELS iteration order).
- [ ] `watch` / `await_events` emit the transition into the new state with `sourceLabel === 'blocked:stuck-merge-conflicts'` so downstream consumers can dispatch on the exact label, not just the tier.
- [ ] Operator on `cockpit:auto` who was previously escalated with "unrecognized state" now sees the merge-conflicts escalation gate instead.

### US2 — Existing `blocked:stuck-feedback-loop` behavior does not regress

**As an** operator whose issue reaches `blocked:stuck-feedback-loop`,
**I want** cockpit's classification of that label to keep working the way #883 designed it,
**So that** the PR-feedback stuck-loop pause continues to surface at the top of the waiting pipeline (or however this spec chooses to migrate it — see [NEEDS CLARIFICATION](#assumptions)).

**Acceptance Criteria**:
- [ ] Behavior for `blocked:stuck-feedback-loop` is explicitly decided (either kept in `waiting` tier via a per-label override, or migrated to `error` tier alongside `blocked:stuck-merge-conflicts` — see FR-002 / clarification Q1).
- [ ] Whatever choice is made, existing unit tests that pin `blocked:stuck-feedback-loop` behavior either continue to pass or are updated deliberately with rationale in the test file.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The classifier must map `blocked:stuck-merge-conflicts` to the `error` tier. | P1 | Same tier as `agent:error` / `failed:*` (rank 1 in `TIER_RANK`). |
| FR-002 | Define the classification rule scope for `blocked:*`: either **(a)** all `blocked:*` labels go to `error` tier (broad), or **(b)** only enumerated `blocked:*` labels go to `error` and the rest stay in `waiting`. | P1 | Needs clarification — `blocked:stuck-feedback-loop` (#883) is currently pinned to `waiting` with an explicit pipeline-order entry, so choice (a) would migrate it too. |
| FR-003 | Within a single classification result where multiple `blocked:*` and `waiting-for:*` labels coexist, the emitted `sourceLabel` MUST be the specific `blocked:*` label (not the `waiting-for:*` co-occurrent). | P1 | Guarantees downstream dispatch on the exact label. |
| FR-004 | The classifier's error-tier tie-break within `blocked:*` labels themselves must be deterministic (e.g. by `WORKFLOW_LABELS` index or by a small explicit ordering list — TBD). | P2 | Only matters when two `blocked:*` labels co-exist, which is not observed today but is possible in principle. |
| FR-005 | `watch` and `await_events` must emit the transition with the real source label (i.e. `blocked:stuck-merge-conflicts`), not a generic "error" placeholder. | P1 | Verified by the existing emit pipeline in `packages/cockpit`; likely a no-op if `sourceLabel` already threads through, but must be tested. |
| FR-006 | A unit test in `packages/cockpit/src/state/__tests__/` must pin: `classify(['waiting-for:merge-conflicts', 'blocked:stuck-merge-conflicts'])` → `{ state: 'error', sourceLabel: 'blocked:stuck-merge-conflicts' }`. | P1 | Regression coverage — this is the exact scenario snappoll#3 and #13 hit. |
| FR-007 | The change must not alter the classification of any workflow label outside the `blocked:*` family. | P1 | Bounded blast radius. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Zero "unrecognized-state" escalations for `blocked:stuck-merge-conflicts` in a `cockpit:auto` run that hits the merge-conflict handler's block path. | 0 | Repeat the snappoll scenario (or unit-simulate an issue with both labels) and check the escalation summary. |
| SC-002 | Downstream `cockpit:auto` dispatch (companion agency-side issue) can route on `sourceLabel === 'blocked:stuck-merge-conflicts'` without additional label re-inspection. | Dispatch works | Trace or unit test on the auto skill's dispatch table after the companion issue lands. |
| SC-003 | `classify()` returns `state: 'error'` for the blocked-merge-conflicts scenario, and the `sourceLabel` is the blocked label (not the waiting-for co-occurrent). | 100% | Unit test (FR-006). |
| SC-004 | No test in `packages/cockpit/src/state/__tests__/` regresses without an intentional, documented update (per US2). | 0 unexplained regressions | CI. |

## Assumptions

- The classifier's current `blocked:*` → `waiting` branch in `label-map.ts:36-39` is the sole rule that needs to change; no consumer of `mapLabelToState` outside the classifier depends on `blocked:*` being `waiting`. *(To verify during planning.)*
- The `cockpit:auto` skill's dispatch table will get a companion PR that maps `blocked:stuck-merge-conflicts` (and any other newly-error-tier `blocked:*`) to the existing merge-conflicts escalation gate. **This spec covers only the classifier change**, not the auto-skill routing.
- **[NEEDS CLARIFICATION — Q1]** Should the rule migrate *every* `blocked:*` label to `error` tier (including `blocked:stuck-feedback-loop`, currently a top-of-waiting-pipeline entry from #883), or should it be scoped to only `blocked:stuck-merge-conflicts` (and future explicit additions), leaving `blocked:stuck-feedback-loop` in `waiting`? The `#883` design deliberately placed `blocked:stuck-feedback-loop` in the waiting pipeline; treating all `blocked:*` as error may be a regression there.
- **[NEEDS CLARIFICATION — Q2]** When both `blocked:stuck-merge-conflicts` and `agent:error` (or `failed:*`) are present on the same issue, which should win the `sourceLabel` slot? Both are error-tier; the current within-tier tie-break uses `workflowLabelIndex`. Is that acceptable, or does the blocked label need to outrank `agent:error` explicitly?

## Out of Scope

- Changes to the `cockpit:auto` skill's dispatch table (companion agency-side issue).
- Changes to the orchestrator's `merge-conflict-handler` label-application logic (already correct per #898 / #902).
- Introducing new label values or changing existing label descriptions in `label-definitions.ts`.
- Any change to `waiting-for:merge-conflicts` classification.
- UI / dashboard rendering of the new tier (cockpit is CLI-only in the caller path involved here).

## References

- Source issue: [#943](https://github.com/generacy-ai/generacy/issues/943)
- Related label origin: [#898 — merge-conflict resolution handler](../898-found-during-cockpit-v1/spec.md)
- Related classifier context: [#916 — cockpit classifier](../916-found-during-cockpit-v1/spec.md), [#883 — `blocked:stuck-feedback-loop` pipeline placement](../precedence.ts) (see `packages/cockpit/src/state/precedence.ts:26-31`)
- Files most likely to change:
  - `packages/cockpit/src/state/label-map.ts` (the `blocked:*` branch in `classifyByPattern`)
  - `packages/cockpit/src/state/precedence.ts` (if a new intra-error tie-break is added)
  - `packages/cockpit/src/state/__tests__/*.test.ts` (regression coverage per FR-006)

---

*Generated by speckit; enhanced with issue context on 2026-07-15.*
