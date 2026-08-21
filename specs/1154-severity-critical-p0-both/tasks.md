# Tasks: Resume label-strip makes the remediation-limit and on-ci-green approval gates un-answerable

**Input**: Design documents from `/specs/1154-severity-critical-p0-both/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Overview

Bug fix (single package `@generacy-ai/orchestrator`). Three source files plus four test files plus one changeset. All source references are pinned at develop `155b3464`; the branch has diverged, so implement against the **symbols** named below, not raw line numbers.

Both P0 fixes sit behind the epic's existing feature flags (`reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`; `ciMergeGateEnabled` / `WORKER_CI_MERGE_GATE_ENABLED`) — a flag-OFF cluster is unaffected.

---

## Phase 1: Baseline

- [X] T001 Establish a green baseline before editing: `pnpm install` then `pnpm --filter @generacy-ai/orchestrator build` and `pnpm --filter @generacy-ai/orchestrator test`. Confirm the existing suite passes so post-change failures are attributable to this work.
- [X] T002 Locate the concrete edit sites (symbols, not line numbers) and confirm they match the plan:
  - `packages/orchestrator/src/worker/label-manager.ts`: the completed-strip loop inside `onResumeStart()`; confirm `isHumanGateCompletion()` and `HUMAN_GATE_SUFFIXES` exist and how the set is derived.
  - `packages/orchestrator/src/worker/phase-resolver.ts`: the `GATE_MAPPING` object literal (`remediation-limit` entry as the insertion anchor).
  - `packages/orchestrator/src/worker/phase-loop.ts`: the "Remediation limit reached" gate-body comment site, the remediation-limit reset+re-arm branch (`resetRemediationCount` + `removeLabels(['completed:remediation-limit'])`), the terminal no-op short-circuit (requires both `completed:validate` and `completed:implementation-review`), and the clean-review side-effect block (`phase === 'review'` + `artifact.verdict === 'clean'`).

## Phase 2: Core Implementation

- [X] T010 [P] [US3] FR-004: Add `'ci': { phase: 'validate', resumeFrom: 'validate' }` to `GATE_MAPPING` in `packages/orchestrator/src/worker/phase-resolver.ts` (insert after the `remediation-limit` entry). This auto-includes `ci` in the derived `HUMAN_GATE_SUFFIXES` and gives `completed:ci` a defined resume phase (no full-revalidate fallback). Do NOT touch `getEffectiveGateMapping()`'s `ciMergeGateEnabled` override or `WORKFLOW_GATE_MAPPING`.

- [X] T011 [P] [US1][US2] FR-001: In `onResumeStart()` (`packages/orchestrator/src/worker/label-manager.ts`), guard the `completed:<suffix>` removal with `!this.isHumanGateCompletion(completedLabel)` so human-answer gate completions survive the resume strip. Leave the stale `waiting-for:*` and `agent:paused` removals unchanged. (Chosen over the pre-strip-snapshot alternative per research.md Decision 1.)

- [X] T012 [US1] FR-005: Marker-dedupe the "Remediation limit reached" gate-body comment in `packages/orchestrator/src/worker/phase-loop.ts`. Define `REMEDIATION_LIMIT_MARKER = '<!-- generacy-remediation-limit -->'`, prepend it to the comment body, and before posting grep `context.github.listPrCommentBodies(owner, repo, prNumber)` for the marker — skip the `addIssueComment` when already present (same pattern as `maybePostUntrustedNotice`).

- [X] T013 [US1] FR-006: In the clean-review side-effect block of `packages/orchestrator/src/worker/phase-loop.ts` (`phase === 'review' && result.success && artifact.verdict === 'clean'`), add a best-effort defensive clear of a lingering `completed:remediation-limit`: fetch `getIssueLabels`, and if present call `removeLabels(owner, repo, issueNumber, ['completed:remediation-limit'])` inside a try/catch that warns on failure (non-fatal). This is distinct from and additional to FR-002's reset-branch removal (Q3→B).

> Note (FR-002 / FR-003): no code change required. The remediation-limit reset+re-arm branch and the terminal no-op short-circuit already exist and are correct; they simply become reachable once T011 stops the strip from removing the labels they read. Verified by the T021 integration test.

## Phase 3: Tests

- [X] T020 [P] [US3] SC-005: `packages/orchestrator/src/worker/__tests__/phase-resolver.ci-gate.test.ts` — assert `PhaseResolver.resolveStartPhase(labels, 'continue', ...)` with `completed:ci` present resolves to `validate` via the normal mapping (not the `resolveFromProcess` fallback), and assert `HUMAN_GATE_SUFFIXES.has('ci')` is `true`. (contracts/gate-mapping-ci.md)

- [X] T021 [US1][US2] FR-007 / SC-001 / SC-002: `packages/orchestrator/src/worker/__tests__/phase-loop.resume-gates.integration.test.ts` — build a `PhaseLoop` with a **real** `LabelManager` (so `onResumeStart()` actually runs) and a fake label-backed `GitHubClient` that models mutable label state.
  - SC-001: add `completed:remediation-limit` + `waiting-for:remediation-limit`, resume, assert the answer survives `onResumeStart`, the remediation counter resets to 0, the gate label is cleared (re-arm), and the loop proceeds without an immediate re-pause on the same count.
  - SC-002: add `completed:implementation-review` with `completed:validate` present (ciMergeGate ON), resume, assert the terminal no-op short-circuit is taken and `validate` does NOT re-run.

- [X] T022 [P] [US1][US2] SC-003: `packages/orchestrator/src/worker/__tests__/label-manager.onresumestart.test.ts` — unit test on `onResumeStart()` asserting every `completed:<X>` for `X ∈ HUMAN_GATE_SUFFIXES` is retained while stale `waiting-for:*` and `agent:paused` are still removed, and non-gate `completed:<phase>` labels are unaffected. (contracts/onresumestart-strip.md)

- [X] T023 [P] [US1] SC-004: `packages/orchestrator/src/worker/__tests__/phase-loop.remediation-comment-dedupe.test.ts` — assert the `REMEDIATION_LIMIT_MARKER` suppresses a second "Remediation limit reached" comment on a resume/re-pause cycle (marker already present in `listPrCommentBodies` → no second `addIssueComment`), and that a genuinely new cap pause after the marker is cleared posts once more.

## Phase 4: Verification & Release

- [X] T030 Hand-write `.changeset/1154-resume-gate-strip.md` — `@generacy-ai/orchestrator` **patch** (internal bug fix across `label-manager.ts`, `phase-resolver.ts`, `phase-loop.ts`; no new public exports, no new label vocabulary since `waiting-for:ci` / `completed:ci` already ship from #1133). It must be a NEWLY ADDED file per the changeset CI gate. Verify with `changeset status` (reads the directory).

- [X] T031 Run the targeted suites and full package check: `pnpm --filter @generacy-ai/orchestrator test label-manager.onresumestart`, `... phase-loop.resume-gates`, `... phase-resolver.ci-gate`, `... phase-loop.remediation-comment-dedupe`, then `pnpm --filter @generacy-ai/orchestrator build` and full `pnpm --filter @generacy-ai/orchestrator test`. Confirm all five success criteria are met and no regressions.

## Dependencies & Execution Order

**Phase order**: Phase 1 (baseline) → Phase 2 (implementation) → Phase 3 (tests) → Phase 4 (verification). Phase 3 tests depend on their Phase 2 implementations existing.

**Within Phase 2 — parallel opportunities**:
- T010 (`phase-resolver.ts`) and T011 (`label-manager.ts`) touch different files → run in parallel `[P]`.
- T012 and T013 both edit `phase-loop.ts` → must run sequentially (same file), and after T010/T011 land conceptually (no hard file dependency, but keep them ordered to avoid merge churn).

**Within Phase 3 — parallel opportunities**:
- T020, T022, T023 are separate test files → parallel `[P]`.
- T021 is the integration test and exercises the real `onResumeStart()` + reset/no-op branches; it depends on T010, T011, T013 being in place.

**Test-to-implementation mapping**:
- T020 ← T010 (FR-004)
- T021 ← T011 (FR-001) + T013 (FR-006) + existing FR-002/FR-003 branches
- T022 ← T011 (FR-001)
- T023 ← T012 (FR-005)

**Playbook coupling**: none — no `packages/claude-plugin-cockpit/commands/*.md` file is edited by this issue (cockpit gate-answer wording is explicitly out of scope). No `playbook-verification.test.ts` re-pin task required.
