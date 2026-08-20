# Tasks: Phase-5 closeout — migration notes, per-repo config examples, rollout checklist + dogfood

**Input**: Design documents from `/specs/1136-context-phase-5-closeout/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

This is a **documentation + operational** issue (no code under `packages/*/src/` → no changeset). Every documented flag/label/shape/marker MUST be copied from shipped Phase 1–4 code; where prose and code disagree, code is authoritative (FR-008).

## Phase 1: Grounding (source-of-truth audit before writing any prose)

- [ ] T001 [P] Re-read the findings-artifact source of truth `packages/orchestrator/src/worker/review-artifact.ts` and confirm `ReviewArtifactSchema` field/enum shapes match `specs/1136-context-phase-5-closeout/contracts/findings-artifact.md` and `data-model.md` (path `.generacy/review-findings-<sanitized-workflowId>.json`; severity `critical|major|minor`; status `open|resolved`; verdict `clean|changes-required`; `round`, `remediationCount`). Note any drift for FR-008 correction.
- [ ] T002 [P] Re-read the review-marker source of truth `packages/orchestrator/src/worker/review-poster.ts` and confirm the body marker prefix `generacy-engine-review` (`<!-- generacy-engine-review round=<N> -->`) and inline marker `<!-- generacy-finding:<marker> -->` match `specs/1136-context-phase-5-closeout/contracts/review-marker.md`. Note any drift.
- [ ] T003 [P] Re-read the flags/gates/config source of truth (review executor, remediate machinery, CI merge gate, and per-workflow config keys) and confirm `WORKER_REVIEW_PHASE_ENABLED` / `WORKER_CI_MERGE_GATE_ENABLED` default-OFF, the gate labels `waiting-for:remediation-limit` (+ `completed:remediation-limit` resume/counter-reset), `waiting-for:ci`, the relocated post-validate `implementation-review` gate, and the `orchestrator.workflows.<name>` keys (`maxRemediations`, `review.profile`, `review.blockingSeverity`, `validateCommand`, `ciWaitTimeoutMs`, opt-in `failThenPass`) against `data-model.md`.
- [ ] T004 [P] Read existing `docs/docs/reference/bugfix-profile-config.md` and confirm it still matches shipped code (research Decision 7) so the migration guide links to it rather than duplicating; record the exact doc id (`reference/bugfix-profile-config`) for the sidebar wiring.

## Phase 2: Author documentation pages (each a separate new file — parallel)

- [ ] T005 [P] [US1][US2] Author `docs/docs/guides/generacy/review-remediate-migration.md` (FR-001, FR-002, FR-005). Cover: (a) adding `ready_for_review` to `ci.yml` `pull_request` types and the skipped-CI-reads-as-SUCCESS footgun the merge gate closes; (b) slimming `validateCommand` to fast checks (lint/format/typecheck/build) with the single-package + root-config-diff guardrails; (c) copy-pasteable per-workflow config examples for BOTH `speckit-feature` and `speckit-bugfix` under `orchestrator.workflows.*`; (d) feature flags `WORKER_REVIEW_PHASE_ENABLED` / `WORKER_CI_MERGE_GATE_ENABLED` default-OFF; (e) gate semantics — `remediation-limit` (fires at counter cap, inspect surfaced findings, resume via `completed:remediation-limit`, resume resets counter, contrasted with the retired `blocked:stuck-feedback-loop` dead-end), relocated post-validate `implementation-review` final approval, `waiting-for:ci` bounded-wait→timeout→resumable pause. Link to `bugfix-profile-config.md` (do NOT duplicate). Use facts confirmed in T001–T004.
- [ ] T006 [P] [US3] Author `docs/docs/reference/review-artifacts.md` (FR-003), hybrid style: inline summary of the findings-artifact sidecar shape (from T001) AND the engine-authored review marker (from T002), each marked engine-internal (GitHub review state is never source of truth), keyed by the contract-name strings `generacy-engine-review` / `generacy-finding:` for the generacy-cloud mirror — PLUS links to the canonical shipped files `review-artifact.ts` (#1124) and `review-poster.ts` (#1125) as authoritative source.
- [ ] T007 [P] [US4] Author `docs/docs/guides/generacy/review-remediate-rollout.md` (FR-004, FR-005) as a standalone repo-agnostic checklist: ordering publish `@channel` packages → restart cluster → restart workers → fresh Claude session; explicit "`generacy update` is NOT sufficient"; canary story on a clearly-marked `<CANARY-REPO>` placeholder (no hard-coded repo); rollback note via the two feature flags to the pre-epic flow.
- [ ] T008 [P] [US5] Author `docs/docs/guides/generacy/review-remediate-dogfood.md` (FR-006, FR-007) as an unchecked in-repo runbook (checkbox list): drive one feature story through `implement → review ⇄ remediate → validate → final gate → merge`; drive one bugfix through the same loop under the bugfix profile; record findings and link results back to epic generacy-ai/generacy#1120; repo-agnostic `<CANARY-REPO>` placeholder; note the live run is a post-merge operator step (the PR does not block on it).

## Phase 3: Sidebar wiring (depends on pages existing — link resolution)
<!-- Phase boundary: Complete Phase 2 before starting Phase 3 -->

- [ ] T009 [US1][US3][US4][US5] Edit `docs/sidebars.ts` (FR-009, Q5→A). Under Guides → Generacy `items` (after `guides/generacy/configuration`): add `guides/generacy/review-remediate-migration`, `guides/generacy/review-remediate-rollout`, `guides/generacy/review-remediate-dogfood`. Under Reference `items` at the category root (beside API/Configuration/CLI): add `reference/bugfix-profile-config` (retroactive orphan fix) and `reference/review-artifacts`.

## Phase 4: Reconciliation audit (FR-008)

- [ ] T010 [US1] FR-008 doc/code reconciliation audit: scan existing docs for any prose that contradicts shipped Phase 1–4 behavior (flags, gate labels, sidecar/marker shapes, config keys) and correct in place. Expected scope none-to-minimal (research Decision 7) — do not pre-emptively rewrite unrelated pages.

## Phase 5: Verification (acceptance gate)
<!-- Phase boundary: Complete Phases 2–4 before starting Phase 5 -->

- [ ] T011 [US1][US3][US4][US5] Run the Docusaurus build as the acceptance gate (SC-007): `cd docs && npm ci && npm run build`. It MUST exit 0 with `onBrokenLinks: 'throw'` — proving every new page is reachable and every internal cross-link (including the migration guide → `bugfix-profile-config.md` link) resolves. Fix any dangling link and re-run until clean.
- [ ] T012 [US1][US2][US3][US4][US5] Content review against acceptance criteria and quickstart §Verify: migration topics present (SC-001: CI trigger, validateCommand slimming, per-workflow examples, flags); all three gates + both contracts documented (SC-002); rollout checklist ordered publish→cluster restart→worker restart→fresh session with "`generacy update` insufficient" + `<CANARY-REPO>` placeholder + flag rollback (SC-003); dogfood runbook has unchecked feature + bugfix items linking epic #1120 (SC-004/SC-005); all four new pages + `bugfix-profile-config` reachable in the rendered sidebar (SC-007).

## Dependencies & Execution Order

**Phase boundaries (sequential):**
- Phase 1 (grounding) → Phase 2 (authoring) → Phase 3 (sidebar wiring) → Phase 4 (audit) → Phase 5 (verification).
- Phase 2 depends on Phase 1: prose must be grounded in the re-read source files (FR-008).
- Phase 3 depends on Phase 2: sidebar entries reference page ids that must exist or the build (`onBrokenLinks:'throw'`) breaks.
- Phase 5 depends on Phases 2–4: the build + content review validate the finished set.

**Parallel opportunities:**
- T001–T004 (grounding reads) are all independent — run in parallel.
- T005–T008 (the four doc pages) are independent files — run in parallel after grounding.
- T009 (single-file `sidebars.ts` edit) is sequential; it touches one shared file and needs all pages present.

**Notes:**
- No changeset: the diff touches only `docs/` and `specs/` — no non-test file under `packages/*/src/` — so the changeset gate does not apply.
- No playbook coupling: no `packages/claude-plugin-cockpit/commands/*.md` file is edited by this issue, so no `playbook-verification.test.ts` re-pin task is required.
- The live dogfood run (US5) is an operator step performed after this PR merges (Q1→C); the mergeable deliverable is the committed runbook artifact, not the live evidence.
