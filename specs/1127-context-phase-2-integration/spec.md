# Feature Specification: implement→review→ready flow end-to-end (Phase-2 integration)

**Branch**: `1127-context-phase-2-integration` | **Date**: 2026-08-19 | **Status**: Draft

## Summary

Phase-2 (P2) integration checkpoint for the epic *engine-native review & remediate phases* (generacy-ai/generacy#1120). P2 lands three orchestrator executors: the review executor with a structured findings artifact and engine-internal verdict (#1124), the PR review posting + draft/ready lifecycle (#1125), and re-review convergence for delta-scoped verification passes (#1126). This issue proves those three are **wired together end-to-end** before the P3 remediate machinery lands.

This issue ships **no product behavior of its own**. It ships **integration tests** that drive a worker phase loop through `implement → review → (clean verdict) → PR ready → validate`, plus the changes-required branch exercised up to the `remediate` seam (a stub `remediate`, since the real executor is P3/#1128). It also ships/pins two **durable contract artifacts** that Phase 3 builds against: the **engine-authored review marker** (so `PrFeedbackMonitorService` can exclude the engine's own review threads — the seam #1130 depends on) and the **findings-artifact** sidecar shape.

## Context

- The `review` phase is linear, entered after `implement`, for both `speckit-feature` and `speckit-bugfix` (landed in P1/#1121; wired to a real executor in P2/#1124).
- Review is an **agent phase over the PR diff** — no tests or builds. Its output is a structured findings artifact (engine-internal sidecar, pause-context pattern): findings with severity (`critical | major | minor`), file/line, round number, and an overall verdict. **GitHub review state is never the source of truth** — the cluster account owns the PR and `REQUEST_CHANGES` on your own PR is a 422 (design footgun).
- Findings post to the PR as a **`COMMENT`-event review** with inline threads, carrying an **engine-authored marker** so the PR-feedback monitor can exclude them (#1130 relies on this contract).
- **Clean verdict** → `markReadyForReview` (repo CI starts) → worker proceeds into `validate`. **Blocking findings** → the loop backtracks off-sequence toward `remediate` (P3); entering remediate converts the PR back to draft.
- Remediate is **off-sequence** and is P3 (#1128); it is out of scope here except as a **stub** that lets the harness exercise the review→remediate→re-review seam and the draft-conversion transition.

Depends on: #1124 (review executor + findings artifact), #1125 (PR posting + draft/ready lifecycle), #1126 (re-review convergence). This issue integrates them; it does not re-implement any.

### Open decisions (to resolve in `/clarify`)

- **[NEEDS CLARIFICATION] Dependency landing order.** Mirroring P1 (#1123 Q1=B), the intended pattern is: #1124/#1125/#1126 merge to `develop` first, this branch is **rebased** on them, and it ships **only** integration tests + the contract artifacts (no re-implementation, no test-only doubles standing in for the real executors — except the P3 `remediate` stub). Confirm this vs. co-landing.
- **[NEEDS CLARIFICATION] Contract authorship vs. pinning.** The engine-authored review marker and findings-artifact shape are produced by #1124/#1125. This issue must land the marker/artifact **contracts documented in shipped code/contracts** (issue Acceptance). Confirm whether those contract docs are *authored here* (this issue is the documentation home) or *already shipped by #1124/#1125 and merely asserted + cross-referenced here*.
- **[NEEDS CLARIFICATION] `remediate` stub fidelity.** The changes-required branch needs a stub `remediate` that (a) returns control to a delta-scoped re-`review` and (b) triggers the ready→draft conversion. Confirm the stub is a test-only double injected through the existing phase-loop seam (as in #1123), not a shipped placeholder executor.

## User Stories

### US1: Engine developer proves the clean-review happy path end-to-end

**As a** developer building on the review phase,
**I want** an integration test that drives the worker phase loop through `implement → review → clean verdict → COMMENT-event review posted → PR marked ready → validate starts`,
**So that** the P2 executors (#1124/#1125/#1126) are proven to sequence, post, and flip lifecycle state together — not just in isolation.

**Acceptance Criteria**:
- [ ] The loop runs `review` immediately after `implement` (both `speckit-feature` and `speckit-bugfix`).
- [ ] A clean review verdict produces a findings artifact with an empty/at-or-below-`blockingSeverity` finding set and an overall "clean" verdict.
- [ ] A `COMMENT`-event PR review is posted carrying the engine-authored marker (never `REQUEST_CHANGES` on the own PR).
- [ ] On clean verdict, the PR is marked ready (`markReadyForReview`) and the loop advances into `validate`.

### US2: Engine developer exercises the changes-required branch up to the remediate seam

**As a** developer who will build the real remediate executor (P3),
**I want** the integration harness to drive a review that returns blocking findings, back through a stub `remediate`, into a delta-scoped re-`review`,
**So that** the review→remediate→re-review seam (including ready→draft conversion) is proven before #1128 lands the real executor.

**Acceptance Criteria**:
- [ ] A review verdict with at/above-`blockingSeverity` findings routes the loop off-sequence toward `remediate` (stub).
- [ ] If the PR was already marked ready, entering remediate converts it **back to draft**.
- [ ] After the stub `remediate`, control backtracks to a `review` pass (delta-scoped), not to the next linear phase.
- [ ] A clean verdict on the re-review re-marks the PR ready and resumes forward.

### US3: The PR-feedback monitor never races the engine's own review loop

**As a** maintainer relying on the P3 monitor exclusion (#1130),
**I want** a test that proves `PrFeedbackMonitorService` does **not** trigger on engine-authored review threads,
**So that** when P3 wires external-feedback routing into remediate, the monitor excludes the engine's own inline threads by the documented marker contract instead of racing the engine.

**Acceptance Criteria**:
- [ ] Engine-authored review threads/comments carry a stable, documented marker.
- [ ] `PrFeedbackMonitorService`'s engine-authored-exclusion predicate returns "exclude" for a comment/thread carrying that marker (asserted against the real predicate, following the existing marker-family precedent).
- [ ] The marker contract and the findings-artifact shape are captured in a shipped `contracts/` artifact and/or load-bearing code comment.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | An integration test drives the worker phase loop end-to-end through `implement → review → clean verdict → PR ready → validate` for both `speckit-feature` and `speckit-bugfix`. | P1 | The P2 happy-path proof. |
| FR-002 | On a clean review verdict, the test asserts a `COMMENT`-event PR review is posted (never `REQUEST_CHANGES`) carrying the engine-authored marker. | P1 | Closes the own-PR 422 footgun by construction. |
| FR-003 | On a clean verdict, the test asserts the PR is marked ready (`markReadyForReview`) and the loop advances into `validate`. | P1 | Draft/ready lifecycle (#1125) wired into the loop. |
| FR-004 | The changes-required branch is exercised: a blocking verdict routes off-sequence toward a **stub** `remediate`, converts the PR back to draft if it was ready, then backtracks to a delta-scoped re-`review`. | P1 | Stub remediate acceptable — real executor is P3/#1128. |
| FR-005 | A test asserts `PrFeedbackMonitorService` does **not** trigger on engine-authored review threads — the engine-authored exclusion predicate returns "exclude" for the documented marker. | P1 | The seam #1130 depends on. |
| FR-006 | The engine-authored review marker contract is documented in shipped code/contracts (stable prefix, match rule, authorship rule — deterministic code, never LLM free-write), mirroring the existing clarification-marker families. | P1 | Durable acceptance artifact. |
| FR-007 | The findings-artifact (sidecar) shape is documented in a shipped `contracts/` artifact and/or load-bearing code comment (fields: severity enum, file/line, round number, overall verdict). | P1 | Durable acceptance artifact; the shape P3 remediate consumes. |
| FR-008 | No real `remediate` executor, remediation counter, `waiting-for:remediation-limit` gate, validate-failure routing, external-feedback routing, or merge-conflict re-arm is introduced. | P1 | Those are P3–P4; this issue is P2 integration + the two contracts only. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Phase-2 integration suite passes in CI. | Green | CI run on the PR. |
| SC-002 | Both workflows traverse `implement → review → ready → validate` on a clean verdict. | 2/2 workflows | Test assertions in the harness. |
| SC-003 | A `COMMENT`-event review with the engine-authored marker is posted; no `REQUEST_CHANGES` on the own PR. | 1 COMMENT / 0 REQUEST_CHANGES | Assertion on the posting call. |
| SC-004 | The changes-required branch reaches the remediate seam and backtracks to a re-review with the correct ready↔draft transitions. | 1 round-trip | Draft/ready state + phase-sequence assertion. |
| SC-005 | `PrFeedbackMonitorService` excludes engine-authored review threads. | Excluded | Assertion against the real exclusion predicate. |
| SC-006 | The engine-authored marker + findings-artifact contracts ship in the diff. | 2 artifacts | `contracts/` doc(s) and/or load-bearing code comments present in the PR. |

## Assumptions

- #1124/#1125/#1126 merge to `develop` **first** and this branch is rebased on them (mirrors #1123 Q1=B); this issue ships only integration tests + the contract artifacts and does not re-implement the executors. The implement phase blocks until the P2 executors land. *(Pending `/clarify` confirmation.)*
- The `remediate` used by the changes-required branch is a **test-only stub** injected through the existing phase-loop dependency seam — no production remediate executor ships here.
- The engine-authored review marker follows the established marker-family convention (stable `<!-- generacy-… -->` prefix, line-anchored, case-sensitive, stamped exclusively by deterministic code — see `packages/orchestrator/src/worker/clarification-markers.ts`).
- `review`/`remediate` map to the `implementation` stage (#1121 FR-002); review is autonomous, so no `waiting-for:review` gate is introduced. The only human gates in the broader design are remediation-limit (P3) and final approval (P4).
- CI draft/ready specifics (repos needing `ready_for_review` in `pull_request` types, skipped≠passed) are P4 (#1133) — this issue asserts the engine's `markReadyForReview`/draft-conversion calls, not repo CI behavior.

## Out of Scope

- Real `remediate` executor: remediation counter, `waiting-for:remediation-limit` gate, retiring the validate-fix handler, external-feedback routing into remediate, merge-conflict re-arm (P3 — #1128–#1132).
- The actual monitor change that excludes engine threads and routes external feedback into remediate (#1130) — this issue only proves/pins the marker contract that change consumes.
- Merge readiness (skipped≠passed), validate/CI parallelism, post-validate approval gate, bugfix targeted-validate profiles (P4 — #1133/#1134/#1135).
- Severity-gating policy tuning, re-review convergence *rules* semantics beyond exercising the delta-scoped backtrack, and any `/cockpit:auto` playbook slimming (agency#500) or docs/rollout (#1136).

---

*Generated by speckit*
