# Feature Specification: Resume label-strip makes the remediation-limit and on-ci-green approval gates un-answerable

**Branch**: `1154-severity-critical-p0-both` | **Date**: 2026-08-21 | **Status**: Draft
**Issue**: [generacy-ai/generacy#1154](https://github.com/generacy-ai/generacy/issues/1154) | **Epic**: [#1153](https://github.com/generacy-ai/generacy/issues/1153) (follow-up to [#1120](https://github.com/generacy-ai/generacy/issues/1120)) | **Severity**: critical (P0)

## Summary

Two human gates introduced by the engine-native review/remediate epic (#1120) are **un-answerable**: when an operator answers the gate (adds the `completed:<gate>` label) and the workflow resumes, the resume housekeeping silently deletes the operator's answer before the phase loop can read it — so the gate re-evaluates as if it were never answered and re-parks the workflow.

Root cause: `LabelManager.onResumeStart()` (`label-manager.ts:349-360`), a pre-existing step that runs before the phase loop on every `continue` command (`claude-cli-worker.ts:756-758`), strips `completed:<X>` for **every** co-present `waiting-for:<X>` gate. Pre-epic gates survived this because `GATE_MAPPING` resumed at a *later* phase (past the gate), so the phase loop never re-checked the stripped label. The two new epic gates re-evaluate **at the resumed phase**, and both depend on the `completed:<X>` label still being present inside the loop.

- **Remediation-limit gate** (`waiting-for:remediation-limit`): the operator adds `completed:remediation-limit` → monitor enqueues a resume → strip removes the label → a full review CLI round re-runs → the gate re-evaluates with the remediation counter still ≥ cap → re-pauses. The counter-reset + re-arm branch (`phase-loop.ts:1468-1493`) is only reachable when `completed:remediation-limit` is present, which the strip guarantees it is not. Net: the counter never resets, every operator answer burns one review CLI round, and the workflow never advances. Compounding defect: the gate-body comment (`phase-loop.ts:1399-1433`) has no dedupe marker, so every re-pause posts another "Remediation limit reached" comment.

- **On-ci-green implementation-review gate** (`waiting-for:implementation-review`, `#1133`): the operator approves by adding `completed:implementation-review` → strip removes the label → the terminal no-op short-circuit (`phase-loop.ts:365-386`) requires **both** `completed:validate` and `completed:implementation-review` → with the approval gone, `validate` re-runs in full (tests + mark-ready + CI wait) → the gate re-fires → re-parks. Approval never terminates the workflow.

An `isHumanGateCompletion()` guard and a `HUMAN_GATE_SUFFIXES` set already exist in `label-manager.ts:57-86` (derived from `GATE_MAPPING` + `WORKFLOW_GATE_MAPPING` + a supplemental static list) but are **not consulted** by `onResumeStart()`. Additionally, the CI wait-timeout gate suffix `ci` (`waiting-for:ci` / `completed:ci`, from `#1133`) is absent from `GATE_MAPPING`, so `completed:ci` resumes only work via the full-revalidate fallback and `ci` is not covered by the guard.

---
Filed from a post-merge code review of epic generacy-ai/generacy#1120. Part of follow-up epic generacy-ai/generacy#1153. All line refs at develop `155b3464`.

## User Stories

### US1: Answer the remediation-limit gate and have the workflow proceed (P0)

**As an** operator triaging a stuck review↔remediate loop,
**I want** adding `completed:remediation-limit` to resume the workflow with a fresh remediation budget,
**So that** my answer actually unblocks the issue instead of burning a review round and re-parking.

**Acceptance Criteria**:
- [ ] Adding `completed:remediation-limit` to a paused issue resumes the workflow, resets the remediation counter to 0, removes the operator label to re-arm the gate, and proceeds past the gate (does not immediately re-pause on the same count).
- [ ] The resume path exercises the real `onResumeStart()` strip — the `completed:remediation-limit` answer survives long enough for the reset+re-arm branch to run.
- [ ] No duplicate "Remediation limit reached" comment is posted across a resume/re-pause cycle; a second comment appears only for a genuinely new cap pause.

### US2: Approve the on-ci-green implementation-review gate and have the workflow terminate (P0)

**As an** operator approving a PR whose CI is green,
**I want** adding `completed:implementation-review` to terminate the workflow cleanly,
**So that** approval finalizes the run instead of re-running `validate` and re-parking at the same gate.

**Acceptance Criteria**:
- [ ] With `ciMergeGateEnabled` on, adding `completed:implementation-review` to an issue already carrying `completed:validate` resumes and terminates via the terminal no-op short-circuit — `validate` (tests, mark-ready, CI wait) does **not** re-run.
- [ ] The `completed:implementation-review` answer survives the `onResumeStart()` strip so the terminal no-op check sees both required labels.

### US3: CI-timeout gate resumes cleanly (P1)

**As an** operator resuming an issue paused at `waiting-for:ci` after CI turns green,
**I want** `completed:ci` to resume through the normal gate mapping,
**So that** the resume does not depend on the full-revalidate fallback and the `ci` gate is treated consistently with every other human gate.

**Acceptance Criteria**:
- [ ] `ci` is present in `GATE_MAPPING` (and therefore in the derived `HUMAN_GATE_SUFFIXES`), so `completed:ci` resolves a defined resume phase and is exempt from the resume strip.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `onResumeStart()` MUST NOT strip `completed:<X>` labels that denote a human-answer gate (i.e. where `X ∈ HUMAN_GATE_SUFFIXES`). Stale `waiting-for:*` and `agent:paused` labels are still removed; non-gate phase completions are unaffected. | P0 | **[Clarified Q1→A]** Exemption covers the **full** `HUMAN_GATE_SUFFIXES` set (not narrowed to at-phase gates). Repeatable clarification-style gates resume at a *later* phase, so a surviving `completed:<X>` is never re-checked at the resume phase → no immediate-refire regression. Reuse the existing `isHumanGateCompletion()` guard (`label-manager.ts:83-86`). Alternative allowed by the issue: evaluate the reset / no-op / already-satisfied checks against a pre-strip label snapshot the worker already fetched. Pick one at plan time. |
| FR-002 | On resuming the remediation-limit gate, the workflow MUST reset the remediation counter to 0 and remove `completed:remediation-limit` (re-arm), then proceed past the gate. This must be reachable via a real resume, not only via directly-injected labels. | P0 | The reset branch at `phase-loop.ts:1468-1493` becomes reachable once FR-001 preserves the label. |
| FR-003 | On resuming the on-ci-green implementation-review gate, the workflow MUST terminate via the terminal no-op short-circuit without re-running `validate`. | P0 | Terminal no-op check (`phase-loop.ts:365-386`) sees both `completed:validate` and `completed:implementation-review` once FR-001 preserves the approval label. |
| FR-004 | `ci` MUST be added to `GATE_MAPPING` (`phase-resolver.ts:9-18`) as `{ phase: 'validate', resumeFrom: 'validate' }` so `completed:ci` resumes via the normal mapping and is included in the derived `HUMAN_GATE_SUFFIXES`. | P1 | **[Clarified Q2→A]** Resume re-runs `validate` to re-verify CI is green on the new head (per US3). `waiting-for:ci` is raised during `validate` (`completed:validate` not yet present), so the terminal no-op short-circuit cannot fire — a terminal treatment would be unreachable. Today `completed:ci` resume only works via the full-revalidate fallback. |
| FR-005 | The remediation-limit gate-body comment MUST be deduped so a resume/re-pause cycle does not post duplicate "Remediation limit reached" comments. | P1 | Hidden marker + existing-comment grep (same pattern as other engine-authored markers). Subsumes the deferred "spurious comment on resume" nit. |
| FR-006 | A stale `completed:remediation-limit` label that lingers after a clean post-resume review MUST NOT silently pre-satisfy the *next* cap pause. A **defensive clear** of `completed:remediation-limit` MUST run on any successful clean pass through the `review` phase, in addition to FR-002's reset-branch removal. | P1 | **[Clarified Q3→B]** FR-006 is distinct from and additional to FR-002: the reset-branch removal (`phase-loop.ts:1468-1493`) only fires when the resume runs the reset branch; a `completed:remediation-limit` that was never consumed by that branch must still be cleared on a clean `review` pass so a future genuine cap pause remains answerable. |
| FR-007 | An integration test MUST drive a resume through the real `onResumeStart()` strip for both P0 gates (not by injecting labels directly into the phase loop). | P0 | Existing unit tests bypass `onResumeStart` and therefore never caught this class of bug. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Remediation-limit resume advances the workflow | 1 operator answer → 0 additional cap re-pauses on the same count | Integration test: add `completed:remediation-limit`, resume through the real strip, assert counter reset + gate cleared + phase loop proceeds |
| SC-002 | Implementation-review approval terminates the run | `validate` executes 0 times on resume | Integration test: add `completed:implementation-review` with `completed:validate` present, resume through the real strip, assert terminal no-op short-circuit taken and no `validate` re-run |
| SC-003 | Human-gate answers survive the resume strip | 0 `completed:<human-gate>` labels removed by `onResumeStart()` | Unit test on `onResumeStart()` asserting human-gate completions are retained while stale `waiting-for:*` / `agent:paused` are still removed |
| SC-004 | No duplicate gate-body comments | ≤ 1 "Remediation limit reached" comment per distinct cap pause | Test asserting marker-dedupe suppresses a second comment on a re-pause cycle |
| SC-005 | `ci` gate resumes via mapping | `completed:ci` resolves a defined resume phase without the full-revalidate fallback | Unit test on `PhaseResolver` / `GATE_MAPPING` + membership assertion in `HUMAN_GATE_SUFFIXES` |

## Assumptions

- The intended semantics of `onResumeStart()`'s `completed:` strip was to re-arm *repeatable* clarification-style gates (follow-up questions require another pause cycle), not to discard terminal operator answers. Exempting human-answer gate completions preserves the repeatable-gate re-arm for gates designed around it while unblocking the two terminal gates.
- `HUMAN_GATE_SUFFIXES` is the correct exemption set: derived from `GATE_MAPPING` + `WORKFLOW_GATE_MAPPING` + a supplemental static list, it cannot be shrunk by a repo-level workflow override.
- The remediation-limit reset (counter=0 + re-arm) and the CI-merge terminal no-op short-circuit are otherwise correct; the only defect is that the labels they depend on are removed before they run.
- Both P0 fixes sit behind the epic's existing feature flags (`reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`; `ciMergeGateEnabled` / `WORKER_CI_MERGE_GATE_ENABLED`), so a flag-OFF cluster is unaffected.
- All source line references are pinned at `develop` @ `155b3464`.

## Out of Scope

- Redesigning the gate/resume label protocol or the `GATE_MAPPING` resume-phase semantics for pre-epic gates (they already work).
- Changing the review executor, remediate executor, CI merge-readiness evaluation, or PR posting logic from #1120 — those land as-is; this fix only concerns the resume label lifecycle.
- The monitor's pause/resume pairing requirement (`label-monitor-service.ts:185-208`) — requiring `waiting-for:` to be present for the resume event to fire is correct and unchanged.
- Cockpit / `/cockpit:auto` gate-answer wording or UI (agency repo).

---

*Generated by speckit*
