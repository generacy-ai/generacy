# Clarifications

## Batch 2026-08-21

### Q1: Corner 1 — flag-OFF validate-failure outcome
**Context**: With both flags default `false`, the #1129/#1158 validate-fix routing is gated on `reviewPhaseEnabled === true` and the old base-advance / `ValidateFixHandler` one-shot was deleted. A default-cluster validate failure now escalates straight to `failed:validate` with no autonomous fix attempt — a regression from pre-epic behavior.
**Question**: How should a validate-phase failure behave on a default (flags-OFF) cluster?
**Options**:
- A: Restore an autonomous flag-OFF fallback fixer so a validate failure gets one bounded fix attempt before escalation.
- B: Accept the regression — flag-OFF validate failures escalate to `failed:validate` with no autonomous fix — and document it in the migration/rollout docs.

**Answer**: A — Restore an autonomous flag-OFF fallback fixer so a validate failure gets one bounded fix attempt before escalation. Rationale: flag-OFF is the default deployment; deleting the pre-epic autonomous validate-fix silently escalates every default-cluster validate failure to `failed:validate` — a real regression. FR-009 carves Corner-1 decisions out of the byte-identical guarantee, so one bounded attempt is in-scope.

### Q2: Corner 2 — `blocked:stuck-feedback-loop` behavior vs docs
**Context**: The label permanently strands PRs on the default path (the PR-feedback monitor skips all `blocked:*` labels). This is deliberate — it is the only bounded stop for the #883 runaway on the flag-OFF legacy path — but the migration guide describes the label as "retired." The #883 bound must be preserved either way.
**Question**: How should the `blocked:stuck-feedback-loop` discrepancy be reconciled?
**Options**:
- A: Keep the label's bounded-stop behavior and correct the "retired" wording in the docs (doc edit may be tracked in the docs issue).
- B: Change the label's role to match the "retired" description, replacing it with another bounded stop that still bounds the #883 runaway.

**Answer**: A — Keep `blocked:stuck-feedback-loop`'s bounded-stop behavior and correct the "retired" wording in the docs. Rationale: it is the only bounded stop for the #883 runaway on the flag-OFF PR-feedback path (the monitor skips all `blocked:*`); FR-004 makes preserving that bound an invariant. Fixing the docs is zero-risk; changing the label's role risks a #883 re-regression.

### Q3: Corner 3 — speckit-bugfix `on-ci-green` gate under `ciMergeGateEnabled`
**Context**: speckit-bugfix's `implementation-review` gate was `condition: 'on-request'` (dead code pre-epic). The #1133 relocation transform matches on `gateLabel` only and unconditionally rewrites every `waiting-for:implementation-review` gate to `{ phase: 'validate', condition: 'on-ci-green' }`, so with `ciMergeGateEnabled === true` speckit-bugfix gains a mandatory human pause it never had.
**Question**: Should speckit-bugfix carry the relocated post-validate `on-ci-green` `implementation-review` gate when `ciMergeGateEnabled === true`?
**Options**:
- A: Yes — intentionally carry the gate (bugfix gets a human/CI merge pause), and add a test locking that in.
- B: No — narrow the #1133 relocation transform to exclude speckit-bugfix so it keeps no human pause.

**Answer**: A — Yes, intentionally carry the relocated `on-ci-green` `implementation-review` gate for speckit-bugfix under `ciMergeGateEnabled`, and add a test locking it in. Rationale: `ciMergeGateEnabled` is opt-in and its purpose is a post-validate CI-green merge checkpoint across speckit workflows; excluding bugfix would let it merge with no checkpoint exactly when the operator asked for one, and keeps the #1133 transform uniformly label-based.

### Q4: Corner 4 — capping unknown-workflow review↔remediate loops
**Context**: `getPhaseSequence` falls back to `PHASE_SEQUENCE` (which includes `review` when `reviewPhaseEnabled === true`), but `config.gates[workflowName]` is `undefined` for any workflow not in the default map, so `GateChecker.checkGates` returns `[]` and no `on-remediation-limit` gate is ever applied — an uncapped review↔remediate loop.
**Question**: How should the uncapped-loop risk for unknown/custom workflows be closed?
**Options**:
- A: Gate the `getPhaseSequence` fallback to exclude `review` (and `remediate`) for unknown workflows — no review phase without a matching gate map.
- B: Apply the default gate set (including `on-remediation-limit`) to unknown workflows so the review loop is capped.

**Answer**: A — Gate the `getPhaseSequence` fallback to exclude `review` (and `remediate`) for unknown workflows, so there is no review phase without a matching gate map. Rationale: the review phase is a speckit concept paired with a specific gate map; grafting the default gate set onto an arbitrary custom workflow injects unrelated gates. Excluding review fails closed — removing the loop's precondition rather than retrofitting a cap onto a sequence the engine doesn't understand (SC-002).
