# Tasks: Fix control-plane daemon cluster.yaml path resolution

**Input**: Design documents from `/specs/630-summary-control-plane-daemon/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [ ] T001 [US2] Create `packages/control-plane/src/services/project-dir-resolver.ts` — 4-tier async resolver with module-level cache and `resetGeneracyDirCache()` export for testing. Tier 1: `GENERACY_PROJECT_DIR` env → `${value}/.generacy`. Tier 2: `WORKSPACE_DIR` env → `${value}/.generacy`. Tier 3: `readdir('/workspaces')` + stat for single `.generacy/cluster.yaml` match. Tier 4: CWD-relative `.generacy`. Log on each fallback tier used.
- [ ] T002 [US1] Modify `packages/control-plane/src/routes/app-config.ts` — replace inline `getGeneracyDir()` (lines 40-46) with `import { resolveGeneracyDir } from '../services/project-dir-resolver.js'`. Update `readManifest()` to `await resolveGeneracyDir()` instead of sync `getGeneracyDir()`.

## Phase 2: Tests

- [ ] T003 [P] [US2] Create `packages/control-plane/tests/unit/project-dir-resolver.test.ts` — unit tests covering all 4 tiers: env var set (tier 1), WORKSPACE_DIR fallback (tier 2), single glob match (tier 3), multiple glob matches warning + CWD fallback (tier 4), zero matches + CWD fallback (tier 4). Use temp dirs and env manipulation; call `resetGeneracyDirCache()` between tests.
- [ ] T004 [P] [US1] Verify existing `app-config` route tests still pass after the `readManifest()` change (run `pnpm --filter @generacy-ai/control-plane test`).

## Dependencies & Execution Order

- T001 must complete before T002 (T002 imports the new module)
- T003 and T004 can run in parallel after T002
- Total: 4 tasks, 2 parallelizable in Phase 2
