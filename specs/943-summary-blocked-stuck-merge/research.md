# Research: Cockpit classifier — `blocked:*` error tier (#943)

## Origin of the label

- `packages/orchestrator/src/worker/merge-conflict-handler.ts` — `MergeConflictHandler` applies `blocked:stuck-merge-conflicts` (constant `BLOCKED_STUCK_MERGE_CONFLICTS_LABEL` at line 63) after its single autonomous attempt fails. Label description in `label-definitions.ts:112-115`: "Merge-conflict resolver (#898) exhausted its one autonomous attempt. Remove to retry."
- `packages/orchestrator/src/worker/validate-fix-handler.ts` — parallel handler for `blocked:stuck-validate-fix` (constant `BLOCKED_STUCK_VALIDATE_FIX_LABEL` at line 12). Same handler-gave-up semantics: duplicate evidence, no-diff, or sibling overlap.
- Both handlers leave `waiting-for:*` in place when they apply the block; the `blocked:*` is additive.

## Current classifier behaviour

- `packages/cockpit/src/state/label-map.ts:35-39` — every `blocked:*` label falls through the generic prefix branch and classifies as `waiting`. `blocked:stuck-feedback-loop` gets an explicit pin at the top of `WAITING_PIPELINE_ORDER` (`packages/cockpit/src/state/precedence.ts:29`, added by #883).
- Because the merge-conflict / validate-fix handlers apply `blocked:*` alongside `waiting-for:merge-conflicts` or `waiting-for:validate-fix`, cockpit picks the `waiting-for:*` gate as `sourceLabel` (it wins the workflow-index tie-break inside the `waiting` tier). The `blocked:*` signal is silently dropped from the surfaced state.
- Downstream consumer (agency-side snappoll routing) does not have a case for `blocked:stuck-merge-conflicts` and treats it as unrecognized state → generic "never guess" gate → operator interrupt. Observed 3× in snappoll#13 (2026-07-15).

## Alternatives considered

| Option | Notes | Decision |
|--------|-------|----------|
| Migrate every `blocked:*` label to `error` (spec Q1 Option C) | Would silently reverse #883's explicit `waiting`-pipeline pin on `blocked:stuck-feedback-loop` and rewrite its tests. Out of scope for this fix. | Rejected (CD-1). |
| Migrate only `blocked:stuck-merge-conflicts` (Q1 Option A) | Ships the exact same bug on the validate-fix path the moment its handler exhausts its remedy. Handler semantics are identical to merge-conflicts (auto-remedy gave up, operator action required). | Rejected (CD-1). |
| Enumerated allow-list of the two "handler-gave-up" labels (Q1 Option B) | Covers both known observation points, preserves #883 exactly, defaults new `blocked:*` names to the safer `waiting` disposition. | **Chosen** (CD-1). |
| Keep `workflowLabelIndex` tie-break inside `error` (Q2 Option A) | `agent:error` / `failed:*` win by label-registration order, so the escalation-specific label loses to the generic one — the exact bug this issue exists to fix, one tier higher. | Rejected (CD-2). |
| Blocked outranks `failed:*` only (Q2 Option C) | Half-measure — `agent:error` can still mask the block. Not observed in the snappoll data, but the ambiguity is unnecessary given the pipeline pattern is already in the codebase. | Rejected (CD-2). |
| Add explicit `ERROR_PIPELINE_ORDER` list in `precedence.ts` mirroring `WAITING_PIPELINE_ORDER` (Q2 Option B + Q3 Option B) | Single reviewable location for intra-error ordering; decouples precedence from `label-definitions.ts` iteration order. Same shape and comparator pattern as the two existing pipeline lists. | **Chosen** (CD-2 + CD-3). |
| Fall through to `workflowLabelIndex` for the intra-blocked tie-break (Q3 Option A) | Coupling behaviour to label-registration order in a separate package. If someone reorders `label-definitions.ts` for cosmetic reasons, cockpit tie-break flips silently. | Rejected (CD-3). |

## Implementation patterns reused

- **Enumerated set beside the prefix rule**: `TERMINAL_COMPLETED_LABELS` in `label-map.ts:7-11` promotes a small set of `completed:*` names to `terminal` while every other `completed:*` falls through to `stage-complete`. The `#943` fix uses the exact same shape for the `blocked:*` promotion.
- **Pipeline-order comparator branch**: `compareSourceLabels` in `precedence.ts:70-105` already has two tier branches (`waiting`, `stage-complete`) with identical `indexOf` + fall-through-to-`workflowIndex` structure. The new `error` branch is a copy of those.
- **Add-a-`describe`-block test extension**: `#883: blocked:* labels classify as waiting` (lines 193-223) and `#926: waiting-for:address-pr-feedback is a promoted waiting gate` (lines 225-279) both live in `classifier.test.ts` and follow the same "one describe per ticket, four to eight specific assertions" layout. `#943` follows suit.

## Key sources / references

- Spec: `specs/943-summary-blocked-stuck-merge/spec.md`
- Clarifications batch 1 (2026-07-15): `specs/943-summary-blocked-stuck-merge/clarifications.md`
- Prior art (blocked:* → waiting pipeline pin): `specs/883-found-during-cockpit-v1/plan.md`
- Prior art (validate-fix handler introducing `blocked:stuck-validate-fix`): `specs/892-found-during-cockpit-v1/plan.md`
- Handler source of `blocked:stuck-merge-conflicts`: `packages/orchestrator/src/worker/merge-conflict-handler.ts:63`, `merge-conflict-handler.d.ts`
- Handler source of `blocked:stuck-validate-fix`: `packages/orchestrator/src/worker/validate-fix-handler.ts:12`
- Label registration: `packages/workflow-engine/src/actions/github/label-definitions.ts:100-115`
- Current classifier: `packages/cockpit/src/state/{classifier,label-map,precedence}.ts`
- Observed bug data: snappoll auto-run summary noting "Escalations: 3 unrecognized-state (`blocked:stuck-merge-conflicts`)", snappoll#3 and snappoll#13 timestamps in `spec.md` §Evidence.
