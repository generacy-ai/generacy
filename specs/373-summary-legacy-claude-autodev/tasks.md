# Tasks: Remove autodev.json and migrate config to .generacy/config.yaml

**Input**: Design documents from `/specs/373-summary-legacy-claude-autodev/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema Extension

- [ ] T001 [US1] Add `SpecKitConfigSchema` with `paths`, `files`, and `branches` subsections to `packages/generacy/src/config/schema.ts` — include `SlugOptionsSchema`, `SpecKitBranchesSchema`, `SpecKitPathsSchema`, `SpecKitFilesSchema` with all defaults matching current hardcoded values. Add `speckit: SpecKitConfigSchema.optional()` to `GeneracyConfigSchema`. Export `SpecKitConfig` type.

## Phase 2: Config Reading Migration

- [ ] T002 [US1] Migrate `resolveSpecsPath()` in `packages/workflow-engine/src/actions/builtin/speckit/lib/fs.ts` — replace `.claude/autodev.json` JSON parsing with YAML parsing of `.generacy/config.yaml`, read `speckit.paths.specs`, fallback to `"specs"` default
- [ ] T003 [P] [US1] Migrate `resolveTemplatesPath()` in `packages/workflow-engine/src/actions/builtin/speckit/lib/fs.ts` — same pattern, read `speckit.paths.templates`, fallback to `".specify/templates"` default
- [ ] T004 [P] [US1] Migrate `getFilesConfig()` in `packages/workflow-engine/src/actions/builtin/speckit/lib/fs.ts` — read `speckit.files` from `.generacy/config.yaml`, fallback to current defaults
- [ ] T005 [US1] Migrate `loadBranchConfig()` in `packages/workflow-engine/src/actions/builtin/speckit/lib/feature.ts` — replace `.claude/autodev.json` reading with `.generacy/config.yaml` → `speckit.branches`, keep `DEFAULT_BRANCH_CONFIG` as fallback

## Phase 3: Branding Cleanup

- [ ] T006 [P] [US2] Remove `/@autodev\s+continue/i` from `DEFAULT_RESUME_PATTERNS` in `packages/github-issues/src/webhooks/triggers.ts` (keep `/@agent\s+continue/i`)
- [ ] T007 [P] [US2] Remove `label.name === 'autodev:ready'` check in `packages/github-issues/src/webhooks/triggers.ts` (keep `label.name === 'ready'`)
- [ ] T008 [P] [US2] Update CLI phase detection regex from `(speckit|autodev):(\w+)` to `(speckit):(\w+)` in `packages/generacy-extension/src/views/local/runner/actions/cli-utils.ts`
- [ ] T009 [P] [US2] Remove autodev references from `.windsurfrules`

## Phase 4: Tests

- [ ] T010 [US1] Update `packages/workflow-engine/src/actions/builtin/speckit/lib/__tests__/feature.test.ts` — change all `existsFor` mocks from `'autodev.json': false` to `'config.yaml': false`, add test cases for when config.yaml exists with `speckit.branches` section
- [ ] T011 [P] [US1] Add schema tests for new `speckit` section in `packages/generacy/src/config/__tests__/schema.test.ts` — test defaults, full override, partial override, and validation errors

## Phase 5: Cleanup

- [ ] T012 [US1] Delete `.claude/autodev.json`
- [ ] T013 [US2] Verify no remaining functional `autodev` references via grep (exclude specs/ and git history)

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 → Phase 2 → Phase 4 (schema must exist before migration, migration before test updates)
- Phase 3 is independent of Phases 1-2 and can run in parallel with them
- Phase 5 runs last after all other phases complete

**Parallel opportunities within phases**:
- Phase 2: T002 must complete first (establishes YAML parsing pattern in fs.ts), then T003 and T004 can run in parallel. T005 is independent (different file).
- Phase 3: All tasks (T006-T009) can run in parallel — they touch different files
- Phase 4: T010 and T011 can run in parallel — different test files
- Phase 5: T012 then T013 (verify after delete)
