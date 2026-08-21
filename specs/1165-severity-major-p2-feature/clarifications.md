# Clarifications

## Batch 2026-08-21

### Q1: Corner 1 — flag-OFF validate-failure outcome
**Context**: With both flags default `false`, the #1129/#1158 validate-fix routing is gated on `reviewPhaseEnabled === true` and the old base-advance / `ValidateFixHandler` one-shot was deleted. A default-cluster validate failure now escalates straight to `failed:validate` with no autonomous fix attempt — a regression from pre-epic behavior.
**Question**: How should a validate-phase failure behave on a default (flags-OFF) cluster?
**Options**:
- A: Restore an autonomous flag-OFF fallback fixer so a validate failure gets one bounded fix attempt before escalation.
- B: Accept the regression — flag-OFF validate failures escalate to `failed:validate` with no autonomous fix — and document it in the migration/rollout docs.

**Answer**: *Pending*

### Q2: Corner 2 — `blocked:stuck-feedback-loop` behavior vs docs
**Context**: The label permanently strands PRs on the default path (the PR-feedback monitor skips all `blocked:*` labels). This is deliberate — it is the only bounded stop for the #883 runaway on the flag-OFF legacy path — but the migration guide describes the label as "retired." The #883 bound must be preserved either way.
**Question**: How should the `blocked:stuck-feedback-loop` discrepancy be reconciled?
**Options**:
- A: Keep the label's bounded-stop behavior and correct the "retired" wording in the docs (doc edit may be tracked in the docs issue).
- B: Change the label's role to match the "retired" description, replacing it with another bounded stop that still bounds the #883 runaway.

**Answer**: *Pending*

### Q3: Corner 3 — speckit-bugfix `on-ci-green` gate under `ciMergeGateEnabled`
**Context**: speckit-bugfix's `implementation-review` gate was `condition: 'on-request'` (dead code pre-epic). The #1133 relocation transform matches on `gateLabel` only and unconditionally rewrites every `waiting-for:implementation-review` gate to `{ phase: 'validate', condition: 'on-ci-green' }`, so with `ciMergeGateEnabled === true` speckit-bugfix gains a mandatory human pause it never had.
**Question**: Should speckit-bugfix carry the relocated post-validate `on-ci-green` `implementation-review` gate when `ciMergeGateEnabled === true`?
**Options**:
- A: Yes — intentionally carry the gate (bugfix gets a human/CI merge pause), and add a test locking that in.
- B: No — narrow the #1133 relocation transform to exclude speckit-bugfix so it keeps no human pause.

**Answer**: *Pending*

### Q4: Corner 4 — capping unknown-workflow review↔remediate loops
**Context**: `getPhaseSequence` falls back to `PHASE_SEQUENCE` (which includes `review` when `reviewPhaseEnabled === true`), but `config.gates[workflowName]` is `undefined` for any workflow not in the default map, so `GateChecker.checkGates` returns `[]` and no `on-remediation-limit` gate is ever applied — an uncapped review↔remediate loop.
**Question**: How should the uncapped-loop risk for unknown/custom workflows be closed?
**Options**:
- A: Gate the `getPhaseSequence` fallback to exclude `review` (and `remediate`) for unknown workflows — no review phase without a matching gate map.
- B: Apply the default gate set (including `on-remediation-limit`) to unknown workflows so the review loop is capped.

**Answer**: *Pending*
