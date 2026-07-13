# Feature Specification: Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #10 — surfaced by the #839 Q2 clarification context and confirmed live

**Branch**: `841-found-during-cockpit-v1` | **Date**: 2026-07-07 | **Status**: Draft

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #10 — surfaced by the #839 Q2 clarification context and confirmed live.

The classifier's tier precedence (packages/cockpit/src/state/precedence.ts: terminal < error < waiting < active < pending < unknown, lower wins) treats every completed:* label as terminal-tier. Mid-pipeline stage markers are not terminal: christrudelpw/sniplink#2/#3/#4 currently carry completed:specify AND waiting-for:clarification (plus agent:paused), and classify() picks completed:specify — so `cockpit status` renders issues that are actively waiting on the developer as state `terminal`. The primary dashboard shows "nothing to do" for exactly the issues that need a human. (An earlier transient sighting of "terminal completed:specify" during the smoke test was this same bug, not a between-phases race.)

Expected: only completed:validate is a terminal workflow state (per docs/label-protocol.md and the rev 3 state table). Other completed:<stage> labels are informational stage markers and must rank BELOW waiting/error/active — e.g. map completed:validate alone to the terminal tier and the remaining completed:* to a low-precedence stage-complete tier, or exclude non-validate completed:* from source-label selection whenever any waiting-for:*/error label is present.

Regression test: the live label combo {completed:specify, waiting-for:clarification, agent:in-progress, agent:paused} must classify as waiting (sourceLabel waiting-for:clarification); {completed:validate} stays terminal.

Impact beyond display: any consumer trusting classified.state for actionability inherits the blind spot (the #839 startup sweep deliberately routed around it via a raw label scan — that workaround can be simplified back to the classifier once this is fixed).


## User Stories

### US1: Dashboard surfaces actionable issues

**As a** developer using `cockpit status`,
**I want** issues that carry a `waiting-for:*` or `error:*` label to render in the corresponding actionable tier even when a mid-pipeline `completed:*` label (e.g. `completed:specify`, `completed:plan`) is also present,
**So that** issues that need my attention are never hidden under the terminal tier.

**Acceptance Criteria**:
- [ ] Live label combo `{completed:specify, waiting-for:clarification, agent:in-progress, agent:paused}` classifies as `waiting` with `sourceLabel = waiting-for:clarification`.
- [ ] Issue carrying only `{completed:validate}` classifies as `terminal` with `sourceLabel = completed:validate`.
- [ ] Issue carrying only a demoted `completed:*` (e.g. `completed:specify` with no other workflow label) classifies as `stage-complete`, not `terminal`.

### US2: Classifier consumers get accurate actionability

**As a** consumer of `classify()` output (dashboards, sweeps, orchestrator),
**I want** `classified.state` to reflect actionability truthfully,
**So that** I can drop workarounds like the #839 startup sweep's raw label scan and trust the classifier directly.

**Acceptance Criteria**:
- [ ] The #839 startup sweep can be simplified back to a `classify()`-based check without regressing the "issue waiting on developer" detection.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Only `completed:validate` remains in the `terminal` tier. `completed:specify`, `completed:clarification`, `completed:plan`, `completed:tasks`, `completed:implement` and every other non-`validate` `completed:*` label MUST be demoted below `waiting` / `error` / `active`. | P1 | Restores docs/label-protocol.md rev 3 state table. |
| FR-002 | `label-map.ts` encodes the split via **rule form**: an explicit set of terminal `completed:*` labels (starting with `completed:validate`); every other `completed:*` label demotes automatically. New `completed:*` labels default to demoted; promotion to `terminal` is always an explicit act. | P1 | Q2 → B. Failure direction is asymmetric — the bug direction (silent promotion to `terminal` hiding an actionable issue) is impossible under this encoding. |
| FR-003 | Add a new `stage-complete` member to the `CockpitState` union. Demoted `completed:*` labels rank in this tier when no higher-tier workflow-signal label is present. | P1 | Q1 → A. Preserves "phase finished, nothing else happening" as a distinct, durable signal (requeued / stalled issues can sit here). |
| FR-004 | `TIER_RANK` places `stage-complete` at rank 5 and moves `unknown` to rank 6. Full order: `terminal:0 < error:1 < waiting:2 < active:3 < pending:4 < stage-complete:5 < unknown:6` (lower wins). | P1 | Q3 → A. Recognized signals outrank unrecognized ones. |
| FR-005 | Intra-tier tie-break within the demoted `completed:*` set uses a **latest-phase-wins** order table analogous to `WAITING_PIPELINE_ORDER` — e.g. `completed:plan` beats `completed:specify` for `sourceLabel` selection. | P1 | Q4 → B. Mirrors the `waiting`-tier pipeline-order pattern; surfaces the most-recent milestone. |
| FR-006 | `compareSourceLabels()` and every existing `TIER_RANK[state]` lookup MUST continue to compile and behave correctly after `unknown` is renumbered to 6. | P1 | Follows from FR-004. |
| FR-007 | Regression test asserts: `{completed:specify, waiting-for:clarification, agent:in-progress, agent:paused}` → `state = 'waiting'`, `sourceLabel = 'waiting-for:clarification'`. | P1 | Locks in the live-observed bug scenario. |
| FR-008 | Regression test asserts: `{completed:validate}` alone → `state = 'terminal'`, `sourceLabel = 'completed:validate'`. | P1 | Guards against over-demotion. |
| FR-009 | Regression test asserts: a demoted-only combo (e.g. `{completed:specify}`) → `state = 'stage-complete'`; and a combo with two demoted labels (e.g. `{completed:specify, completed:plan}`) → `state = 'stage-complete'`, `sourceLabel = 'completed:plan'` (latest-phase-wins). | P1 | Covers FR-003 + FR-005. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Issues with `waiting-for:*` + demoted `completed:*` classify as `waiting` | 100% | Vitest cases per FR-007 pass. |
| SC-002 | `completed:validate` alone still classifies as `terminal` | 100% | Vitest case per FR-008 passes. |
| SC-003 | Demoted-only `completed:*` combos classify as `stage-complete` with latest-phase-wins `sourceLabel` | 100% | Vitest cases per FR-009 pass. |
| SC-004 | Live smoke-test repos (`christrudelpw/sniplink#2`, `#3`, `#4`) render under the `waiting` bucket in `cockpit status`, not `terminal` | 3/3 issues | Run `generacy cockpit status` after fix; visually confirm bucketing. |
| SC-005 | No consumer of `classify()` regresses | 0 test failures | Full `packages/cockpit` test suite green; #839 startup sweep still detects the same issue set (with or without the raw-label-scan workaround). |

## Assumptions

- `docs/label-protocol.md` rev 3 state table is authoritative and requires no update.
- The set of terminal `completed:*` labels is small and stable (in practice just `completed:validate`); the set of demoted `completed:*` labels grows with workflow evolution.
- All existing `classify()` callers read `state` and `sourceLabel` — none depend on the numeric `TIER_RANK` values directly.
- The #839 startup sweep's raw-label-scan workaround can remain in place; simplifying it back is out of scope for this fix (tracked separately).

## Out of Scope

- Simplifying the #839 startup sweep to rely on the fixed classifier (follow-up).
- Cloud-side / dashboard UI changes beyond the classifier output.
- Renaming or removing any existing `completed:*` labels.
- Changing the tier precedence for non-`completed:*` labels.

---

*Generated by speckit*
