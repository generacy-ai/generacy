# Clarifications: Cockpit classifier — `blocked:*` error tier

## Batch 1 — 2026-07-15

### Q1: Scope of `blocked:*` → `error` tier
**Context**: Three `blocked:*` labels exist in `WORKFLOW_LABELS` today: `blocked:stuck-feedback-loop` (#883), `blocked:stuck-validate-fix` (#892), and `blocked:stuck-merge-conflicts` (#898). The spec's Assumptions Q1 frames the scope choice as "all `blocked:*` → error" vs "only enumerated," but only explicitly names `stuck-feedback-loop` (currently pinned to top-of-waiting-pipeline in `precedence.ts:29`) and `stuck-merge-conflicts` (the trigger). `blocked:stuck-validate-fix` is unmentioned and today falls through the generic `blocked:*` branch into `waiting`. The scope decision determines whether it also migrates.
**Question**: Which `blocked:*` labels should classify as `error` tier?
**Options**:
- A: Only `blocked:stuck-merge-conflicts` — narrow enumerated allow-list; `stuck-feedback-loop` stays pinned in the waiting pipeline (#883 preserved), `stuck-validate-fix` stays in `waiting` (status quo). Any future `blocked:*` labels default to `waiting` unless explicitly added.
- B: `blocked:stuck-merge-conflicts` and `blocked:stuck-validate-fix` — both merge-conflict and validate-fix stuck labels are "handler-gave-up" signals with a specific escalation path; keep `stuck-feedback-loop` in `waiting` (#883 preserved).
- C: All `blocked:*` → `error` — broad rule, delete the current `blocked:*` branch under `waiting`, also delete the `blocked:stuck-feedback-loop` entry in `WAITING_PIPELINE_ORDER` and update the #883 unit tests. All three current + future `blocked:*` labels classify as `error`.

**Answer**: B — `blocked:stuck-merge-conflicts` and `blocked:stuck-validate-fix` both classify as error tier; `blocked:stuck-feedback-loop` keeps its #883 waiting-pipeline pin. Rationale: `stuck-validate-fix` is the same signal class as `stuck-merge-conflicts` (auto-remedy exhausted, operator action required) — leaving it in `waiting` ships this exact bug again for the validate-fix path on a future run. The broad rule (all `blocked:*`) would silently reverse #883's explicit precedence decision and rewrite its tests, which is scope this fix doesn't need.

### Q2: Cross-tier tie-break with `agent:error` / `failed:*`
**Context**: `blocked:stuck-merge-conflicts` co-occurring with `agent:error` or `failed:*` is possible in principle (e.g. a merge-conflict block plus a downstream agent error on the same issue). All three land in the `error` tier under this spec. The current within-tier tie-break uses `workflowLabelIndex` (position in `WORKFLOW_LABELS`). Under that rule the winner depends on iteration order in `label-definitions.ts` — `failed:*` and `agent:error` appear well before the `blocked:*` block, so `agent:error` / `failed:*` would win the `sourceLabel` slot by default.
**Question**: When `blocked:stuck-merge-conflicts` co-exists with `agent:error` or `failed:*`, which label should be emitted as `sourceLabel`?
**Options**:
- A: Keep `workflowLabelIndex` tie-break — `agent:error` / `failed:*` win by iteration order. Rationale: they represent a more general error signal; a downstream consumer that wants the blocked-specific label can inspect the full label set.
- B: Blocked labels outrank `agent:error` / `failed:*` — add an explicit intra-`error` pipeline (mirroring `WAITING_PIPELINE_ORDER`) that places `blocked:*` first. Rationale: `blocked:*` carries a specific escalation gate; a generic `agent:error` masks it.
- C: Blocked labels outrank `failed:*` only — `agent:error` still wins (it signals a supervisor-level fault); `blocked:*` outranks phase-level `failed:*`.

**Answer**: B — Blocked labels outrank `agent:error` / `failed:*`: add an explicit intra-error pipeline that places `blocked:*` first. Rationale: `blocked:stuck-merge-conflicts` carries a specific, actionable escalation (the D.11 gate with a known remedy); a generic `agent:error` winning the sourceLabel slot routes the operator to the generic escalation gate — the exact mis-routing this issue exists to fix, one tier higher. Consumers wanting the general signal still see it in the full label set.

### Q3: Deterministic tie-break between multiple `blocked:*` labels
**Context**: FR-004 requires a deterministic tie-break within the `blocked:*` family "by `WORKFLOW_LABELS` index or by a small explicit ordering list — TBD." No issue is observed carrying two `blocked:*` labels today, but it is possible in principle (P2 in the spec). If Q1 → A, this question is moot (only one blocked label in the error tier). If Q1 → B or C, an ordering is needed.
**Question**: How should ties between two co-occurring `blocked:*` labels be broken?
**Options**:
- A: Fall through to `workflowLabelIndex` — the default behavior in `compareSourceLabels` when no pipeline order applies. Simplest; the order is `stuck-feedback-loop` < `stuck-validate-fix` < `stuck-merge-conflicts` by current `label-definitions.ts` position.
- B: Add an explicit `ERROR_BLOCKED_ORDER` list in `precedence.ts` — mirrors `WAITING_PIPELINE_ORDER` for the error tier; lets us reorder without touching label registration order.
- C: N/A — depends on Q1; if Q1 → A, only one blocked label is error-tier and this question is skipped.

**Answer**: B — Add an explicit `ERROR_BLOCKED_ORDER` (or a combined error-pipeline list) in `precedence.ts`, mirroring `WAITING_PIPELINE_ORDER`. Rationale: With Q1=B two blocked labels share the tier, so an ordering is required, and Q2's answer already introduces an intra-error pipeline — one explicit list serves both decisions and keeps precedence in a single reviewable place instead of coupling behavior to label registration order.
