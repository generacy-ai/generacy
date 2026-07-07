# Feature Specification: Cockpit classifier must not treat mid-pipeline `completed:*` labels as terminal

**Branch**: `841-found-during-cockpit-v1` | **Date**: 2026-07-07 | **Status**: Draft | **Issue**: [#841](https://github.com/generacy-ai/generacy/issues/841)

## Summary

The cockpit label classifier (`packages/cockpit/src/state/label-map.ts` + `precedence.ts`) treats every `completed:*` label as tier `terminal`. Terminal outranks every other tier (`terminal < error < waiting < active < pending < unknown`, lower wins), so an issue carrying both `completed:specify` (a mid-pipeline stage marker) AND `waiting-for:clarification` (a live human-actionable gate) classifies as `terminal` with `sourceLabel: completed:specify`. `cockpit status` then renders these issues as "done, nothing to do" — precisely the wrong signal for issues actively blocked on the developer.

Confirmed live during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88, finding #10): `christrudelpw/sniplink#2/#3/#4` all carry the label set `{completed:specify, waiting-for:clarification, agent:in-progress, agent:paused}` and misclassify as terminal. The primary dashboard shows "nothing to do" for exactly the issues that need a human.

**Expected**: Only the true workflow-terminal `completed:*` labels — `completed:validate`, `completed:epic-approval`, `completed:children-complete` — belong in the terminal tier. The other `completed:<stage>` labels (`specify`, `clarify`, `plan`, `tasks`, `implement`, plus the paired `*-review` markers `spec-review`, `clarification`, `clarification-review`, `plan-review`, `tasks-review`, `implementation-review`, `manual-validation`, `setup`) are informational stage markers and must NOT outrank a concurrent `waiting-for:*` / `failed:*` / `agent:error` label when selecting the source-of-truth state.

**Downstream impact**: Any consumer of `classify().state` inherits the blind spot. The #839 startup sweep (in-flight) already had to route around the classifier via a raw label scan to identify actionable states; that workaround can be simplified back to using the classifier once #841 is fixed.

## User Stories

### US1: Operator sees issues that need them

**As a** cockpit operator running `generacy cockpit status <epic-ref>`,
**I want** issues that are simultaneously `completed:<mid-stage>` AND `waiting-for:*` to appear as `waiting` (with the specific `waiting-for:*` gate as the source label),
**So that** the dashboard surfaces issues that need my attention instead of hiding them under a false "terminal / done" state.

**Acceptance Criteria**:
- [ ] Given an issue with labels `{completed:specify, waiting-for:clarification, agent:in-progress, agent:paused}`, `classify()` returns `{ state: 'waiting', sourceLabel: 'waiting-for:clarification' }`.
- [ ] Given an issue with label `{completed:validate}`, `classify()` returns `{ state: 'terminal', sourceLabel: 'completed:validate' }`.
- [ ] Given an issue with the special `closed` label, `classify()` returns `{ state: 'terminal', sourceLabel: 'closed' }`.
- [ ] Existing `cockpit status` output for genuinely-terminal issues (bearing only `completed:validate` / `completed:epic-approval` / `completed:children-complete` / `closed`) is unchanged.

### US2: Downstream consumers can trust `classified.state`

**As a** future maintainer touching cockpit consumers (e.g., the #839 startup sweep, `/cockpit:watch` transition detection),
**I want** `classify().state` to be authoritative for "is this issue actionable?",
**So that** I do not need to re-scan raw labels to work around the classifier's misclassification.

**Acceptance Criteria**:
- [ ] The #839 startup-sweep raw-label workaround (a follow-up refactor, tracked separately) is unblocked: the classifier's `waiting` state alone is sufficient to identify actionable issues in the presence of stage-complete labels.
- [ ] No caller of `classify()` needs a `completed:*`-specific special case to recover correct actionability.

### US3: Regression protection

**As a** contributor changing `label-map.ts` or `precedence.ts`,
**I want** the exact live label combo from the smoke test to be a permanent test fixture,
**So that** this bug class cannot regress silently.

**Acceptance Criteria**:
- [ ] A test in `packages/cockpit/src/__tests__/classifier.test.ts` asserts the {completed:specify, waiting-for:clarification, agent:in-progress, agent:paused} → `waiting` case.
- [ ] A test asserts each remaining mid-pipeline `completed:*` label (from the enumerated list in FR-002) does NOT outrank a concurrent `waiting-for:clarification`.
- [ ] The pre-existing tests for `completed:validate` / `completed:epic-approval` / `closed` → terminal still pass.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | The classifier MUST NOT map mid-pipeline `completed:<stage>` labels to the `terminal` tier when a concurrent `waiting-for:*`, `needs:*`, `failed:*`, `agent:error`, `phase:*`, or `agent:in-progress` / `agent:dispatched` label is present. The concurrent actionable label MUST win as the source label. | P1 | Core bug fix. |
| FR-002 | The set of `completed:*` labels that remain in the terminal tier is exactly: `completed:validate`, `completed:epic-approval`, `completed:children-complete`. The set of `completed:*` labels demoted out of the terminal tier is: `completed:setup`, `completed:specify`, `completed:clarify`, `completed:plan`, `completed:tasks`, `completed:implement`, `completed:spec-review`, `completed:clarification`, `completed:clarification-review`, `completed:plan-review`, `completed:tasks-review`, `completed:implementation-review`, `completed:manual-validation`. | P1 | Enumerated to close the ambiguity of "which `completed:*` is terminal". Source: `packages/workflow-engine/src/actions/github/label-definitions.ts` lines 45–60, cross-referenced against `docs/epic-cockpit-plan.md` §D2. Terminal set matches the current explicit-list in the module docstring; the demoted set is every other `completed:*` currently in `WORKFLOW_LABELS`. |
| FR-003 | Where the demoted `completed:*` labels rank when NO higher-tier label is present is an open question (see clarifications): either a new low-precedence tier below `pending`, or fold them into `pending`, or leave them as `unknown`. Chosen option must not break existing `sourceLabel` selection for issues that carry ONLY a demoted `completed:*` (e.g., between phase transitions, an issue may briefly carry only `completed:plan`). | P1 | Deferred to `/clarify`. |
| FR-004 | The special `closed` label continues to map to `terminal`, unchanged. | P1 | Baseline invariant. |
| FR-005 | Existing classifier public API (`classify(labels: Iterable<string>) → { state, sourceLabel }`) is unchanged. `CockpitState` union may gain one member if FR-003 lands on the new-tier option; otherwise unchanged. | P1 | Additive to the type is acceptable per plan.md §D2; breaking rename is not. |
| FR-006 | Regression tests: (a) the live label combo `{completed:specify, waiting-for:clarification, agent:in-progress, agent:paused}` → `{ state: 'waiting', sourceLabel: 'waiting-for:clarification' }`; (b) parameterized coverage over each demoted `completed:*` label in FR-002 asserting it does not outrank `waiting-for:clarification`; (c) `{completed:validate}` → terminal; (d) `{completed:epic-approval}` → terminal; (e) `{closed}` → terminal. | P1 | Tests live in `packages/cockpit/src/__tests__/classifier.test.ts`. |
| FR-007 | Documentation touch-up in `label-map.ts`'s module docstring (currently claims "any other completed:* → terminal", which is the bug). Docstring MUST reflect the corrected mapping after FR-002/FR-003 land. | P2 | Doc-only cleanup at the fix site. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `generacy cockpit status <epic-ref>` on the live `christrudelpw/sniplink` epic (the smoke-test source) reports issues #2/#3/#4 as `waiting` with `sourceLabel: waiting-for:clarification`. | Exact match (not `terminal / completed:specify`). | Manual smoke test against the sniplink epic before and after fix. |
| SC-002 | Regression test suite in `classifier.test.ts` covers each demoted `completed:*` label from FR-002 alongside `waiting-for:clarification`, `agent:error`, and `failed:plan`. | 100% of the FR-002 demoted labels appear in at least one test case. | Test file review + `pnpm test` for `@generacy-ai/cockpit`. |
| SC-003 | Existing terminal-tier tests (`completed:validate`, `completed:epic-approval`, `closed`) still pass unchanged. | 100% pass. | `pnpm test` for `@generacy-ai/cockpit`. |
| SC-004 | #839's startup sweep raw-label scan can be simplified to use `classify().state === 'waiting' \|\| 'error'` without regression. | Follow-up PR verified by grep: no `label.startsWith('completed:')`-based special case remains in the startup sweep path. | Manual verification after the follow-up lands (tracked separately, not in this PR). |
| SC-005 | No behavior change for issues whose label set does not include a demoted `completed:*` label. | 100% of existing classifier tests pass unchanged (aside from any test that itself encoded the bug). | `pnpm test`. |

## Assumptions

- The label enumeration in `packages/workflow-engine/src/actions/github/label-definitions.ts` (lines 44–60) is the authoritative list of `completed:*` labels the classifier will encounter. New `completed:*` labels added later fall under FR-003's "how are they classified when alone" decision.
- `docs/epic-cockpit-plan.md` §D2 (referenced in `label-map.ts`'s docstring) intends only `closed` / `completed:epic-approval` / `completed:children-complete` / `completed:validate` as terminal; the "any other completed:* → terminal" bullet in the current docstring is the bug, not a spec.
- No cockpit-external consumer relies on mid-pipeline `completed:*` labels classifying as `terminal`. (Grep across `packages/`: only the classifier itself and its test file reference this mapping.)
- The `WAITING_PIPELINE_ORDER` tie-break inside the `waiting` tier is unaffected — `waiting-for:clarification` already appears in the order list, so the source-label pick within `waiting` is deterministic when this fix lands.

## Out of Scope

- Refactoring the #839 startup-sweep raw-label workaround to use `classify()` — that is a follow-up PR after this lands (tracked in SC-004 as a downstream verification, not a deliverable of this feature).
- Changes to the `WORKFLOW_LABELS` list or label-definitions in `@generacy-ai/workflow-engine`.
- Changes to `cockpit status` rendering / output shape; only the classifier result changes.
- Changes to the `waiting` / `active` / `error` / `pending` tier ranks or their intra-tier tie-breaks. Only the mapping of demoted `completed:*` labels moves.
- Adding new user-facing states beyond what FR-003 requires (e.g., a "in-progress-with-recent-stage-completion" state is explicitly not proposed).
- Fixing #839 (referenced only as the sibling bug whose workaround this fix unblocks).

## Clarifications

Two open questions to be resolved via `/clarify` before implementation:

- **Q1 (FR-003 tier landing)**: Where do the demoted `completed:*` labels rank in isolation? Options: (A) new `stage-complete` tier ranked below `pending`; (B) fold into `pending`; (C) fold into `unknown` (effectively skipped by `classify()`). Trade-offs: (A) preserves the ability to surface "issue is between phases" as its own signal but expands the `CockpitState` union; (B) reuses existing pending semantics but conflates "waiting for setup" with "just finished a phase"; (C) is the smallest diff but loses the "phase complete" signal entirely when no other label is present.
- **Q2 (Scope of the FR-002 explicit list)**: Should the demoted-vs-terminal split be encoded as two explicit sets in `label-map.ts` (matching the FR-002 enumeration), OR as a rule "terminal `completed:*` = intersection with the explicit terminal list; everything else in the demoted tier"? The rule form is more resilient to new `completed:*` labels being added to `WORKFLOW_LABELS`, but risks silently reclassifying a future genuinely-terminal label the author forgot to add to the terminal list.

---

*Generated by speckit*
