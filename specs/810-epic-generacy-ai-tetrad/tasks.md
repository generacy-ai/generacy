# Tasks: Sweep #808 residue (release metadata, docs, test surface)

**Input**: Design documents from `/specs/810-epic-generacy-ai-tetrad/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/cleanup-map.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (all tasks belong to US1 — the #808 residue sweep)

## Phase 1: Release Metadata

- [ ] T001 [P] [US1] Delete stale pending changeset `.changeset/792-cockpit-orchestrator-status.md` (FR-001). Verify with `test ! -f .changeset/792-cockpit-orchestrator-status.md`.
- [ ] T002 [P] [US1] Delete stale pending changeset `.changeset/793-cockpit-journal-stuck-detection.md` (FR-001). Verify with `test ! -f .changeset/793-cockpit-journal-stuck-detection.md`.
- [ ] T003 [US1] Append one prose line to `.changeset/805-cockpit-delete-orchestrator-journal.md` covering the `STALE` status column removal and stuck-metadata fields (`stuckAt`, `lastJournalAt`) removed from `StatusRow` (FR-002). Keep frontmatter (MINOR bump for both packages) unchanged. Verify with `grep -E 'STALE|stuckAt|lastJournalAt' .changeset/805-*.md`.

## Phase 2: Docs and Entry-Point Pruning

<!-- Phase boundary: Phase 1 changesets can land first to prevent misrepresenting the release channel if `changeset version` runs mid-PR (see plan.md Risks). Phase 2 edits are independent and can run in parallel with each other. -->

- [ ] T004 [P] [US1] Edit `packages/cockpit/README.md` line 5 — remove the trailing clause "without depending on the orchestrator runtime" (or the whole sentence if it becomes vestigial) so `grep -in orchestrator packages/cockpit/README.md` returns zero hits (FR-003, Q2). Do not touch other content.
- [ ] T005 [P] [US1] Edit `packages/cockpit/package.json` `description` field — drop `", and orchestrator client"` so the value reads `"Foundation library for the Generacy Epic Cockpit: classifier, config loader, epic manifest, gh wrapper"` (FR-004). Verify with `grep -in 'orchestrator client' packages/cockpit/package.json` returns zero.
- [ ] T006 [P] [US1] Edit `packages/cockpit/src/index.ts` header comment (lines 1–3) — remove `orchestrator/http` and `orchestrator/stub` references from the "Internal modules … are NOT exported" line; keep `state/label-map` reference (FR-005). Verify with `grep -in 'orchestrator' packages/cockpit/src/index.ts` returns zero.

## Phase 3: Legacy-Config Tolerance Test

<!-- Phase boundary: Fixture must exist before the test references it. T007 blocks T008. -->

- [ ] T007 [US1] Create new fixture `packages/cockpit/src/__tests__/fixtures/config-samples/legacy-orchestrator-keys.yaml` with the exact nested shape from data-model.md §Entity 2 (`cockpit.owner: alice`, `cockpit.orchestrator.url`, `cockpit.orchestrator.token`, `cockpit.stuckThresholdMinutes: 30`) (FR-006). Nested placement under `cockpit:` is required — loader only forwards `doc['cockpit']` to the schema (Q3).
- [ ] T008 [US1] Append one new `it()` block to `packages/cockpit/src/__tests__/config-loader.test.ts` (inside the existing `describe('loadCockpitConfig', …)`), titled `'strips legacy orchestrator/stuckThresholdMinutes keys nested under cockpit: (R4 strip mode)'` (FR-006, Q3). Use the existing `writeConfig()` helper. Assert: (1) `await` completes without throwing, (2) `result.config.owner === 'alice'`, (3) `(result.config as unknown as { orchestrator?: unknown }).orchestrator === undefined`, (4) `(result.config as unknown as { stuckThresholdMinutes?: unknown }).stuckThresholdMinutes === undefined`. See data-model.md §Entity 3 for the exact test shape.

## Phase 4: Verification

<!-- Phase boundary: All edits must land before verification greps and test runs. -->

- [ ] T009 [US1] Run `pnpm --filter @generacy-ai/cockpit test config-loader` and confirm the new case passes (SC-001 backing).
- [ ] T010 [US1] Run the SC-001 aggregate grep from contracts/cleanup-map.md and confirm zero hits: `grep -RIn 'orchestrator\|ORCHESTRATOR_\|stuckThresholdMinutes\|StuckReason\|readJournalLiveness\|appendChildIssue' packages/cockpit/README.md packages/cockpit/package.json packages/cockpit/src/index.ts 2>/dev/null` (note: `.changeset/805-*.md` is intentionally excluded — it legitimately mentions the removed subsystems by name).

## Dependencies & Execution Order

**Sequential phase boundaries**:
- Phase 1 (release metadata) → Phase 2 (docs) → Phase 3 (test) → Phase 4 (verification)
- Phase 1 recommended first because pending changesets misrepresent the release channel if `changeset version` runs mid-PR (plan.md Risks).
- Phase 3 T008 depends on Phase 3 T007 (test references the fixture).
- Phase 4 depends on all prior phases.

**Parallel opportunities within phases**:
- Phase 1: T001, T002 in parallel (independent file deletes). T003 is a single-file append; independent of T001/T002.
- Phase 2: T004, T005, T006 all in parallel (three different files, no shared state).
- Phase 3: T007 must complete before T008 (fixture-before-test).
- Phase 4: T009 and T010 are independent; can run in parallel.

**Not touched (per Q4, contracts/cleanup-map.md FR-007/FR-008/FR-009)**:
- `packages/generacy/src/cli/commands/cockpit/__tests__/shared.scoping.test.ts` — deleted by #806 (FR-007 moot).
- `packages/generacy/src/cli/commands/cockpit/__tests__/{state,advance,clarify-context,queue}.test.ts` — owned by in-flight #807; verify at #807's review (FR-008 skip).
- `packages/generacy/src/cli/commands/cockpit/__tests__/status.render.test.ts` — already asserts positive on `parsed.scope`/`parsed.rows`; no tombstone present (FR-009 moot on inspection).

---

*Generated by speckit /tasks*
