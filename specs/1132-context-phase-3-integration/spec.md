# Feature Specification: Full review⇄remediate loop end-to-end (Phase-3 integration)

**Branch**: `1132-context-phase-3-integration` | **Date**: 2026-08-20 | **Status**: Draft

## Summary

Phase-3 (P3) integration checkpoint for the epic *engine-native review & remediate phases* (generacy-ai/generacy#1120). P3 lands the machinery that closes the loop: the real `remediate` executor with a remediation counter and `waiting-for:remediation-limit` cap gate (#1128), routing validate failures into `remediate` (#1129), the PR-feedback monitor excluding engine-authored threads and routing external human feedback into `remediate` (#1130), and merge-conflict re-arm targeting a resolution-scoped review (#1131). This issue proves those four are **wired together end-to-end** — the full `review ⇄ remediate` loop, every entry point, from `implement` through a green `validate`.

This issue ships **no product behavior of its own**. It ships an **integration harness scenario suite** that drives a real worker phase loop through the complete convergence path, the cap-pause/resume path, and the external-feedback re-entry path — plus **durable loop-contract artifacts** documenting the sequencing, counter, label, and draft/ready invariants that P3 established. It mirrors the tests-and-contracts-only shape of P1/#1123 and P2/#1127.

## Context

- After P2, the loop runs `implement → review → (clean) → PR ready → validate`; a blocking verdict backtracks off-sequence to `remediate` (a **stub** in P2) and re-reviews delta-scoped. P3 replaces the stub with the real executor and wires the remaining entry points.
- **Remediate is the single remediation loop.** P3 collapses the old validate-fix handler and the PR-feedback fixer into one `remediate` phase with **one counter** (`maxRemediations`, feature 3 / bugfix 2) and **one human escape hatch** (`waiting-for:remediation-limit` at cap — no terminal `blocked:*` dead-ends).
- **Three entry points into `remediate`** now exist: (1) a blocking **review** verdict, (2) a **validate** failure (#1129), (3) **external human PR feedback** after the PR is marked ready (#1130). All three converge on the same off-sequence `remediate` → delta-scoped re-`review` backtrack.
- **Draft/ready lifecycle** is load-bearing: clean review → `markReadyForReview` (CI starts); entering `remediate` from any path converts the PR **back to draft**; a subsequent clean re-review re-marks ready.
- **The cap gate** (`waiting-for:remediation-limit`) pauses the loop when the counter is exhausted, surfaces the remaining open findings for a human, and — on a human answer — **resets the counter** so the loop can converge.
- **Engine-authored review threads are excluded** from the PR-feedback monitor by the marker contract pinned in P2/#1127; #1130 wires that exclusion into `PrFeedbackMonitorService` routing so the engine never races its own review loop. This issue exercises that boundary: only genuinely-external feedback re-enters `remediate`.

Depends on: #1128 (remediate executor + counter + cap gate), #1129 (validate→remediate routing), #1130 (monitor exclusion + external-feedback→remediate routing), #1131 (merge-conflict re-arm → resolution-scoped review). This issue integrates them; it does not re-implement any.

## User Stories

### US1: Engine developer proves the full multi-round convergence path end-to-end

**As a** developer building on the review⇄remediate loop,
**I want** an integration scenario that drives `implement → review (2 blocking) → remediate → re-review (1 resolved, 1 still open) → remediate → re-review clean → ready → validate fails → remediate → re-review → validate green`,
**So that** the P3 executors (#1128–#1131) are proven to sequence, count, post, and flip draft/ready lifecycle together across multiple rounds and both remediation entry points (review-blocking and validate-failure) — not just in isolation.

**Acceptance Criteria**:
- [ ] A review returning two at/above-`blockingSeverity` findings routes the loop into `remediate`, then backtracks to a delta-scoped re-`review`.
- [ ] A re-review that resolves one finding and leaves one open re-enters `remediate` (round 2), then re-reviews again.
- [ ] A clean re-review marks the PR ready and advances into `validate`.
- [ ] A `validate` failure routes back into `remediate` (#1129), converting the ready PR back to draft, then re-reviews and re-validates.
- [ ] A green `validate` after the final remediation round terminates the loop forward (no further backtrack).
- [ ] The findings artifact, remediation counter, and phase/gate labels are consistent at every step.

### US2: Operator resolves a capped loop and watches it converge

**As an** operator supervising a stubborn review loop,
**I want** the scenario where the remediation counter is exhausted to raise the `waiting-for:remediation-limit` gate with the remaining open findings surfaced, and — on my answer — reset the counter so the loop converges,
**So that** a non-converging loop degrades to a single human touchpoint (the cap escape hatch) rather than churning silently or dead-ending in a terminal `blocked:*` state.

**Acceptance Criteria**:
- [ ] When the remediation counter reaches `maxRemediations`, the loop pauses and raises `waiting-for:remediation-limit` (never a terminal `blocked:*`).
- [ ] The remaining open findings are surfaced to the human at the pause point.
- [ ] A human answer resets the counter and resumes the loop.
- [ ] After reset, the loop converges to a clean review and proceeds forward.

### US3: External human feedback after ready re-enters the loop; the engine never races itself

**As a** reviewer who leaves feedback on a ready PR,
**I want** my external review to route the loop back into `remediate` and converge, while the engine's own review threads are excluded from that routing,
**So that** genuine human feedback is honored via the unified remediation loop and the engine does not treat its own COMMENT-event review as external feedback (#1130).

**Acceptance Criteria**:
- [ ] External human feedback on a ready PR routes the loop back into `remediate` (#1130), converting the PR back to draft.
- [ ] Engine-authored review threads (carrying the P2 marker) are **not** treated as external feedback and do **not** trigger re-entry.
- [ ] After remediating the external feedback, a clean re-review re-marks the PR ready and the loop converges.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | An integration scenario drives the full convergence path `implement → review (2 blocking) → remediate → re-review (1 resolved/1 open) → remediate → re-review clean → ready → validate fail → remediate → re-review → validate green` against the real P3 executors. | P1 | The P3 happy-path multi-round proof. |
| FR-002 | A cap-variant scenario asserts that exhausting the remediation counter raises `waiting-for:remediation-limit` (never a terminal `blocked:*`), surfaces the remaining open findings, and — on a human answer — resets the counter and converges. | P1 | The single-human-touchpoint escape hatch (#1128). |
| FR-003 | An external-feedback-variant scenario asserts that human feedback on a ready PR routes back into `remediate` and converges, while engine-authored review threads (P2 marker) are excluded from that routing. | P1 | The #1130 boundary; engine never races itself. |
| FR-004 | Every scenario asserts the draft/ready transitions are correct at each step: clean review → ready; entering `remediate` from any of the three entry points → back to draft; re-clean → ready. | P1 | Draft/ready lifecycle invariant across all entry points. |
| FR-005 | Every scenario asserts **at most one full validate/test-suite execution per clean-review cycle** — the loop does not re-run the suite while findings remain open. | P1 | The epic's core efficiency guarantee. |
| FR-006 | Every scenario asserts the remediation counter, phase/gate labels, and findings artifact are consistent at every transition (counter increments per remediation round, resets on cap answer, labels track the active phase/gate). | P1 | Cross-cutting consistency assertion. |
| FR-007 | The loop contracts (phase sequencing incl. off-sequence backtrack, the three remediate entry points, counter/cap semantics, draft/ready invariant, engine-thread exclusion boundary) are documented in a shipped `contracts/` artifact, cross-referencing #1128–#1131 as the authorship home. | P1 | Durable acceptance artifact; pinned, not re-authored here. |
| FR-008 | No new product behavior is introduced: no changes to the remediate executor, counter, cap gate, validate/external-feedback/merge-conflict routing, or marker/exclusion logic beyond what #1128–#1131 shipped. This issue is P3 integration + the loop-contract artifact only. | P1 | Integration-and-contracts scope guard (mirrors #1123/#1127). |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Phase-3 integration scenario suite passes in CI. | Green | CI run on the PR. |
| SC-002 | The full convergence scenario traverses all rounds and both review-blocking and validate-failure remediation entry points to a green `validate`. | 1 end-to-end pass | Phase-sequence + terminal-state assertions in the harness. |
| SC-003 | The cap variant raises `waiting-for:remediation-limit` (0 terminal `blocked:*`), surfaces remaining findings, and converges after counter reset. | Gate raised, counter reset, converged | Label + counter + findings assertions. |
| SC-004 | The external-feedback variant re-enters `remediate` on genuine human feedback and excludes engine-authored threads. | Re-entry on external only | Routing assertion against external vs. marker-carrying threads. |
| SC-005 | At most one full validate/test-suite execution per clean-review cycle across every scenario. | ≤1 suite run/cycle | Assertion on the suite-invocation count. |
| SC-006 | Draft/ready transitions correct at every step across all three scenarios. | All transitions correct | Draft/ready state assertions. |
| SC-007 | The loop-contract artifact is shipped in the diff, cross-referencing #1128–#1131. | 1 artifact | Presence of `contracts/` doc in the PR. |

## Assumptions

- #1128/#1129/#1130/#1131 merge to `develop` **first** and this branch is rebased on them (mirrors #1123 Q1=B and #1127 Q1=A); this issue ships only the integration scenario suite + the loop-contract artifact and does not re-implement the executors. The implement phase dependency-blocks until the P3 executors land (skip→requeue-after-deps).
- The harness drives a **real** worker phase loop with the real P3 executors; only genuinely external seams (the CLI/agent invocation, GitHub calls, human answers) are mocked/injected through the established phase-loop dependency seams used in #1123/#1127 — no test-only doubles stand in for the P3 executors themselves.
- `review`/`remediate` map to the `implementation` stage (#1121 FR-002); review is autonomous (no `waiting-for:review` gate). The only human gates exercised here are `waiting-for:remediation-limit` (P3) — final `implementation-review` approval moves post-validate in P4 and is out of scope.
- The engine-authored review marker + findings-artifact contracts were authored by P2 (#1124/#1125) and pinned by #1127; this issue relies on and cross-references them, authoring no new wire contract for those.
- Merge readiness (skipped≠passed), validate/CI parallelism, and the post-validate approval gate are P4 (#1133); this issue asserts the engine's phase/lifecycle/counter behavior, not repo CI merge-gating.
- `maxRemediations` defaults (feature 3 / bugfix 2) and severity-gating policy are as shipped by #1128/#1124; the cap-variant scenario drives the counter to its configured limit rather than asserting a specific numeric default.

## Out of Scope

- Any change to the real `remediate` executor, remediation counter, `waiting-for:remediation-limit` gate, validate→remediate routing (#1129), external-feedback→remediate routing + engine-thread exclusion (#1130), or merge-conflict re-arm (#1131) — those are the P3 product issues; this integrates and documents them.
- Merge readiness semantics (skipped≠passed), validate/CI parallelism, post-validate `implementation-review` approval gate (P4 — #1133).
- Bugfix verification-charter shaping and targeted-validate profiles with diff-classification guards (P4 — #1134/#1135).
- `/cockpit:auto` playbook slimming (generacy-ai/agency#500) and migration/docs/rollout (#1136).
- Re-authoring the engine-authored marker or findings-artifact wire contracts (owned by #1124/#1125, pinned by #1127).

---

*Generated by speckit*
