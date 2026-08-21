# Clarifications: Resume label-strip makes the remediation-limit and on-ci-green approval gates un-answerable

Issue: [generacy-ai/generacy#1154](https://github.com/generacy-ai/generacy/issues/1154)

## Batch 1 — 2026-08-21

### Q1: Strip-exemption scope
**Context**: FR-001 says `onResumeStart()` MUST NOT strip `completed:<X>` where `X ∈ HUMAN_GATE_SUFFIXES`. But that derived set (label-manager.ts:69-76) also contains the *repeatable* clarification-style gates (`clarification`, `clarification-review`, `spec-review`, `plan-review`, `tasks-review`). The strip's original purpose (per the code comment at label-manager.ts:349-351) is to re-arm exactly those gates so follow-up questions require a fresh pause cycle. If we exempt the full set, a re-posted `waiting-for:clarification` paired with a *surviving* `completed:clarification` could let the label-monitor immediately fire a resume without the developer answering the new questions — a regression. The two broken gates (remediation-limit, on-ci-green implementation-review) re-evaluate *at the resumed phase*; the repeatable gates resume at a *later* phase.
**Question**: Should the strip exemption cover the full `HUMAN_GATE_SUFFIXES` set (as FR-001 literally states), or be narrowed to only the gates that re-evaluate at the resumed phase?
**Options**:
- A: Full `HUMAN_GATE_SUFFIXES` — exempt every human-gate completion from the strip, as written in FR-001.
- B: Narrow the exemption to the at-phase-re-evaluating gates only (`remediation-limit`, `implementation-review`, `ci`, and `manual-validation`); keep stripping `completed:<X>` for the repeatable clarification-style gates so their re-arm behavior is preserved.

**Answer**: A) Full `HUMAN_GATE_SUFFIXES` — exempt every human-gate completion from the resume label-strip. Rationale: FR-001 literal scope; the Assumptions state the set is correct and cannot be shrunk by a repo-level override; repeatable gates resume at a *later* phase, so a surviving `completed:<X>` is never re-checked at the resume phase (no immediate-refire regression).

### Q2: `ci` gate mapping semantics
**Context**: FR-004 requires adding `ci` to `GATE_MAPPING` (phase-resolver.ts:9-18), which forces a concrete `{ phase, resumeFrom }` choice. `waiting-for:ci` is raised on a CI wait-timeout during the `validate` phase (#1133); the operator resumes after CI turns green by adding `completed:ci`.
**Question**: What resume behavior should `completed:ci` have?
**Options**:
- A: `{ phase: 'validate', resumeFrom: 'validate' }` — resume re-runs `validate` so CI is re-verified green before the workflow proceeds (safest, but repeats validate work).
- B: Treat `completed:ci` as terminal like an approved implementation-review — short-circuit via the terminal no-op check when `completed:validate` is present, without re-running `validate`.

**Answer**: A) `{ phase: 'validate', resumeFrom: 'validate' }` — resume re-runs `validate` so CI is re-verified green before the workflow proceeds. Rationale: `waiting-for:ci` is raised during `validate` (`completed:validate` not yet present), so the terminal no-op short-circuit cannot fire; re-running `validate` re-verifies CI on the new head per US3.

### Q3: Clearing the stale `completed:remediation-limit` label (FR-006)
**Context**: FR-002 already removes `completed:remediation-limit` during the resume reset+re-arm branch (phase-loop.ts:1468-1493). FR-006 additionally warns that a stale `completed:remediation-limit` "that lingers after a clean post-resume review MUST NOT silently pre-satisfy the next cap pause" and "must be cleared once consumed." This implies a path where the label survives past the reset branch.
**Question**: Is FR-002's removal in the reset+re-arm branch the only clear required, or is an additional clear needed when a post-resume review returns clean and the workflow proceeds past `review` without re-hitting the cap?
**Options**:
- A: FR-002's reset-branch removal is sufficient — once the resume runs the reset branch, the label is gone and FR-006 is satisfied by construction.
- B: Add a defensive clear on any successful pass through the `review` phase (clean review), so a `completed:remediation-limit` that was never consumed by the reset branch cannot pre-satisfy a future genuine cap pause.

**Answer**: B) Add a defensive clear of `completed:remediation-limit` on any successful clean pass through the `review` phase. Rationale: FR-006 is distinct from and additional to FR-002 and mandates clearing a consumed remediation-limit so a future genuine cap pause stays answerable; closes the pre-satisfy hole.
