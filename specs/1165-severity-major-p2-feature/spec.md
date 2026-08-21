# Feature Specification: Flag-matrix guardrails for the review/remediate epic

**Branch**: `1165-severity-major-p2-feature` | **Date**: 2026-08-21 | **Status**: Draft

## Summary

**Severity: major (P2).** The engine-native review/remediate epic (generacy-ai/generacy#1120) shipped behind two feature flags — `WORKER_REVIEW_PHASE_ENABLED` (→ `reviewPhaseEnabled`) and `WORKER_CI_MERGE_GATE_ENABLED` (→ `ciMergeGateEnabled`), **both default `false`**. A post-merge code review found four corners of that flag matrix that are either un-decided or unguarded. This spec resolves each into an explicit, tested behavior (whether "fix the code" or "accept + document"). Part of follow-up epic generacy-ai/generacy#1153. Line refs at develop `155b3464`.

The four corners:

1. **Flag-OFF (the default) now has NO autonomous validate-fix at all.** The #1129/#1158 validate-fix routing is gated on `reviewPhaseEnabled === true` (`phase-loop.ts:971`) and the shared `RemediateExecutor` seam is the only remaining fixer (`phase-loop.ts:~1768`); the old base-advance / `ValidateFixHandler` one-shot was deleted. On a default deployment a validate failure now escalates straight to `failed:validate` with no autonomous fix attempt — a regression from pre-epic behavior. **Decision needed:** restore a flag-off fallback, or accept + document the regression.

2. **`blocked:stuck-feedback-loop` still permanently strands PRs on the default path** (`pr-feedback-handler.ts:45`, `:617-626`; the PR-feedback monitor skips *all* `blocked:*` labels at `pr-feedback-monitor-service.ts:566-581`). This is deliberate per the in-code comment (it's the only bounded stop for the #883 runaway on the flag-OFF legacy path), but the migration guide describes the label as "retired." **Decision needed:** align behavior with docs, or align docs with behavior (doc side tracked separately).

3. **speckit-bugfix silently acquired a mandatory human-approval gate.** Its `implementation-review` gate was `condition: 'on-request'` — dead code pre-epic (no evaluator handled that condition). The #1133 relocation transform (`config.ts:229-247`) matches on `gateLabel` only and unconditionally rewrites *every* `waiting-for:implementation-review` gate to `{ phase: 'validate', condition: 'on-ci-green' }`. So with `ciMergeGateEnabled === true`, speckit-bugfix gains a human pause it never had. Possibly desirable — **make it an explicit decision + test.**

4. **Unknown workflow names get review+remediate with no cap gate.** `getPhaseSequence` (`types.ts:85-91`) falls back to `PHASE_SEQUENCE` and includes `review` when `reviewPhaseEnabled === true`, but `config.gates[workflowName]` is `undefined` for any workflow not in the default map, so `GateChecker.checkGates` returns `[]` (`gate-checker.ts:67-80`). No `on-remediation-limit` gate is ever applied → an uncapped review↔remediate loop. **Fix needed:** gate the fallback, or apply default gates to unknown workflows.

## User Stories

### US1: Default-deployment validate failure has a bounded, predictable outcome (Corner 1)

**As an** operator running a default (flags-OFF) cluster,
**I want** a validate-phase failure to behave predictably — either autonomously attempt a fix or clearly escalate — and for that behavior to be documented,
**So that** I am not silently regressed from the pre-epic autonomous validate-fix without knowing it.

**Acceptance Criteria**:
- [ ] The flag-OFF validate-failure behavior is an explicit, decided outcome (fallback fixer restored **or** documented escalation) — resolved in `/clarify`.
- [ ] A test pins the flag-OFF validate-failure path so the behavior cannot silently change again.
- [ ] If the decision is "accept the regression," the migration/rollout docs state that flag-OFF validate failures escalate to `failed:validate` with no autonomous fix.

### US2: `blocked:stuck-feedback-loop` behavior and documentation agree (Corner 2)

**As an** operator or maintainer,
**I want** the treatment of `blocked:stuck-feedback-loop` to be consistent between the running code and the migration guide,
**So that** I can trust the docs when triaging a stranded PR on a default cluster.

**Acceptance Criteria**:
- [ ] Behavior and docs are reconciled: either the label keeps its bounded-stop role and the "retired" wording is corrected, or the label's role is changed to match the "retired" description — decided in `/clarify`.
- [ ] The flag-OFF `blocked:*` monitor-skip continues to bound the #883 runaway (no reintroduction of an unbounded re-enqueue cycle).
- [ ] A test asserts the chosen behavior for the flag-OFF stuck-loop path.

### US3: speckit-bugfix's implementation-review gate is an intentional, tested choice (Corner 3)

**As a** maintainer enabling `ciMergeGateEnabled`,
**I want** speckit-bugfix's acquisition (or non-acquisition) of a human `implementation-review`/`on-ci-green` gate to be a deliberate, tested decision,
**So that** turning on the CI merge gate does not silently insert an unexpected human pause into the bugfix flow.

**Acceptance Criteria**:
- [ ] It is explicitly decided whether speckit-bugfix should carry a post-validate `on-ci-green` gate when `ciMergeGateEnabled === true` — resolved in `/clarify`.
- [ ] The relocation transform reflects that decision (either bugfix keeps the relocated gate intentionally, or it is excluded).
- [ ] A test asserts the resulting speckit-bugfix gate set under both flag states.

### US4: Unknown/custom workflows cannot enter an uncapped review↔remediate loop (Corner 4)

**As an** operator running a custom workflow with `reviewPhaseEnabled === true`,
**I want** the review↔remediate loop to be capped even when my workflow name is not in the default gate map,
**So that** a workflow never loops indefinitely between review and remediate without an operator pause.

**Acceptance Criteria**:
- [ ] With `reviewPhaseEnabled === true` and a workflow name absent from the default gate map, the review↔remediate loop is bounded (a `remediation-limit`-equivalent cap applies) — no unbounded loop.
- [ ] A test drives an unknown workflow through the review phase with the flag on and asserts the loop terminates at the cap.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Resolve Corner 1: the flag-OFF validate-failure outcome must be a single, explicit behavior (restore a fallback fixer **or** accept documented escalation). | P1 | Decision deferred to `/clarify`. |
| FR-002 | Pin the flag-OFF validate-failure behavior with a regression test. | P1 | Prevents silent re-regression. |
| FR-003 | Resolve Corner 2: reconcile `blocked:stuck-feedback-loop` behavior and the migration-guide "retired" wording. | P1 | Behavior change vs doc change decided in `/clarify`; doc edit may be tracked in the docs issue. |
| FR-004 | Preserve a bounded stop for the flag-OFF PR-feedback stuck-loop (no reintroduction of the #883 unbounded re-enqueue). | P1 | Invariant regardless of which side of Corner 2 wins. |
| FR-005 | Resolve Corner 3: explicitly decide whether speckit-bugfix carries the relocated `on-ci-green` `implementation-review` gate under `ciMergeGateEnabled === true`. | P1 | Decision deferred to `/clarify`; may require narrowing the #1133 relocation transform. |
| FR-006 | Test speckit-bugfix's gate set under both `ciMergeGateEnabled` states to lock in the Corner 3 decision. | P1 | |
| FR-007 | Resolve Corner 4: ensure unknown/custom workflows that include the `review` phase (flag ON) always have an effective `on-remediation-limit` cap. | P1 | Either gate the `getPhaseSequence` fallback to exclude `review` for unknown workflows, or apply default gates to unknown workflows. |
| FR-008 | Test that an unknown workflow with `reviewPhaseEnabled === true` cannot enter an uncapped review↔remediate loop. | P1 | |
| FR-009 | With both flags OFF (the default), observable behavior for named workflows must remain byte-identical to pre-change except where Corner 1/2 decisions explicitly alter it. | P1 | Guard against collateral change. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Un-decided flag-matrix corners remaining after this feature | 0 | Each of Corners 1–4 has an explicit, documented decision. |
| SC-002 | Uncapped review↔remediate loops reachable via any workflow name (flag ON) | 0 | FR-007/FR-008 test proves cap applies to unknown workflows. |
| SC-003 | Silent (untested) flag-dependent behavior changes among the four corners | 0 | Each corner has a test asserting behavior under the relevant flag state(s). |
| SC-004 | Flag-OFF named-workflow behavioral drift from pre-change baseline (outside decided Corner 1/2 changes) | none | Existing flag-OFF tests remain green; new tests confirm parity. |

## Assumptions

- Both flags remain default `false`; this feature does not change the default flag values.
- The doc-side edit for Corner 2 (migration guide "retired" wording) may land in the separate docs issue; this spec owns the behavior/decision, and at minimum flags the doc discrepancy.
- The #883 runaway bound on the flag-OFF PR-feedback path must be preserved under any Corner 2 outcome.
- "Unknown workflow" means any `workflowName` not present in the default `config.gates` map / `WORKFLOW_PHASE_SEQUENCES`.
- Changes are confined to the orchestrator worker (phase-loop, gate-checker, config, pr-feedback-handler) plus tests; no cross-package public API change is anticipated (verify at `/plan`).

## Out of Scope

- Changing the default value of either feature flag.
- Redesigning the review/remediate executors, the CI merge-readiness evaluation, or the gate/resume label protocol.
- The full migration-guide rewrite (only the Corner 2 wording reconciliation is in scope here; broader doc work is the docs issue).
- Auto-merge behavior (owned by cockpit).
- Multi-repo / sibling-review coordination changes.

## Open Decisions (for `/clarify`)

- **D1 (Corner 1):** Flag-OFF validate failure — restore an autonomous fallback fixer, or accept + document the escalation regression?
- **D2 (Corner 2):** `blocked:stuck-feedback-loop` — keep as the bounded flag-OFF stop and correct the "retired" docs, or change behavior to match the docs?
- **D3 (Corner 3):** speckit-bugfix under `ciMergeGateEnabled === true` — intentionally carry the relocated `on-ci-green` `implementation-review` gate, or exclude bugfix from the relocation?
- **D4 (Corner 4):** Cap unknown-workflow review loops by excluding `review` from the `getPhaseSequence` fallback, or by applying default gates to unknown workflows?

---

*Generated by speckit*
