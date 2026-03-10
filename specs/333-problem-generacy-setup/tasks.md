# Tasks: Remove hardcoded tetrad-development bootstrap fallback

**Input**: Design documents from `/specs/333-problem-generacy-setup/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Config Package — Add scanForWorkspaceConfig

- [X] T001 [P] Add `scanForWorkspaceConfig()` function to `packages/config/src/loader.ts` — scans immediate subdirs of a parent directory for `.generacy/config.yaml`, returns array of found paths
- [X] T002 [P] Export `scanForWorkspaceConfig` from `packages/config/src/index.ts`
- [X] T003 [P] Add unit tests for `scanForWorkspaceConfig()` — test with 0, 1, and multiple configs found; test that non-directory entries are skipped

## Phase 2: Workspace Command — Rewrite Config Resolution

- [X] T004 Remove hardcoded `tetrad-development` config path lookup (workspace.ts ~lines 62-74)
- [X] T005 Remove Phase 2 bootstrap logic — re-read config after cloning tetrad-development (workspace.ts ~lines 301-340)
- [X] T006 Remove `tetrad-development` repo ordering priority (workspace.ts ~lines 285-289)
- [X] T007 Remove `'bootstrap (config not found)'` from `repoSource` union type in WorkspaceConfig interface
- [X] T008 Add `--config <path>` CLI option to Commander command definition and `config` to WorkspaceCliOptions interface
- [X] T009 Implement new config resolution chain: `--repos` → `REPOS env` → `--config`/`CONFIG_PATH` → `scanForWorkspaceConfig(workdir)` → error with clear message
- [X] T010 Add error handling for multiple configs found — list paths, suggest `--config`

## Phase 3: Tests — Update and Add

- [X] T011 Remove obsolete tests: bootstrap mode, two-phase clone, bootstrap warning (workspace.test.ts ~lines 196, 209, 235, 314)
- [X] T012 [P] Add test: `--config` flag loads config from specified path
- [X] T013 [P] Add test: `CONFIG_PATH` env var loads config from specified path
- [X] T014 [P] Add test: `--config` overrides `CONFIG_PATH` env var
- [X] T015 [P] Add test: discovers config from workdir subdirectory when no explicit config
- [X] T016 [P] Add test: fails with error when no config found anywhere
- [X] T017 [P] Add test: fails with error when multiple configs found in workdir subdirectories
- [X] T018 [P] Add test: `--config` resolves ambiguity when multiple configs exist
- [X] T019 Update existing test `config file is used when no CLI flag and no REPOS env var` to mock `scanForWorkspaceConfig`

## Phase 4: Verification

- [X] T020 Run `pnpm build` for both `@generacy-ai/config` and `@generacy-ai/generacy` packages — verify no type errors
- [X] T021 Run full test suite with `pnpm test` — verify all tests pass

## Dependencies & Execution Order

**Phase 1** (Setup):
- T001, T002, T003 are independent and can run in parallel
- T002 depends on T001 at the file level but they touch different files so can be done together

**Phase 2** (Core — sequential):
- T004-T007 are removals, can be done together in a single editing pass
- T008-T010 implement the new logic, depend on removals being done first
- T009 depends on T008 (needs the `--config` option defined)

**Phase 3** (Tests):
- T011 must be done first (remove obsolete tests before adding new ones)
- T012-T018 are independent and can run in parallel
- T019 updates an existing test, can be done alongside new tests

**Phase 4** (Verification):
- T020 and T021 depend on all prior phases being complete
