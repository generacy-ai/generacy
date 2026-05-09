# Tasks: Phase 4 Cleanup — Remove `GENERACY_CLOUD_URL` Fallback Chains

**Input**: Design documents from `/specs/551-summary-phase-4-cleanup/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Env Var Removal

- [ ] T001 [P] [US1] Remove `GENERACY_CLOUD_URL` fallback from `packages/generacy/src/cli/utils/cloud-url.ts` — drop tier-3 `GENERACY_CLOUD_URL` env var read, remove `resolveCloudUrl` deprecated alias export, update `resolveApiUrl` JSDoc to reference `GENERACY_API_URL`
- [ ] T002 [P] [US2] Remove `GENERACY_CLOUD_URL` fallbacks from `packages/orchestrator/src/config/loader.ts` (lines ~245-290) — activation reads only `GENERACY_API_URL` (throw descriptive error if missing), relay reads only `GENERACY_RELAY_URL` (fall back to channel-derived URL, not old var), remove `?projectId=` auto-append logic
- [ ] T003 [P] [US1] Update comment in `packages/cluster-relay/src/relay.ts` (line ~25) — change `GENERACY_CLOUD_URL` reference to `GENERACY_RELAY_URL`

## Phase 2: Reference Cleanup

- [ ] T004 [P] [US1] Update error messages in `packages/generacy/src/cli/commands/launch/cloud-client.ts` — change 404 user-facing message from `GENERACY_CLOUD_URL` to `GENERACY_API_URL` / `--api-url`
- [ ] T005 [P] [US3] Rename CLI flag in `packages/generacy/src/cli/commands/launch/index.ts` — add `--api-url` as canonical option, move `--cloud-url` to hidden alias with deprecation warning (use Commander `Option.hideHelp()`), update option description to reference `GENERACY_API_URL`
- [ ] T006 [P] [US3] Rename CLI flag in `packages/generacy/src/cli/commands/deploy/index.ts` — same `--api-url` canonical + `--cloud-url` hidden alias pattern as T005

## Phase 3: Test Updates

- [ ] T007 [P] [US1] Update `packages/generacy/src/cli/utils/__tests__/cloud-url.test.ts` — remove tests for `GENERACY_CLOUD_URL` fallback, remove tests for `resolveCloudUrl` alias, add negative assertion that `GENERACY_CLOUD_URL` is not read (set old var, delete new var, expect default)
- [ ] T008 [P] [US2] Update `packages/orchestrator/src/config/__tests__/loader-workspace.test.ts` — replace `GENERACY_CLOUD_URL` assertions with `GENERACY_API_URL`/`GENERACY_RELAY_URL`, add negative assertions verifying old var is not honored, test fail-loud behavior when `GENERACY_API_URL` missing
- [ ] T009 [P] [US1] Update remaining test files — scan `packages/generacy/src/cli/commands/launch/__tests__/cloud-client.test.ts`, `launch/__tests__/scaffolder.test.ts`, `cluster/__tests__/scaffolder.test.ts`, and `tests/unit/deploy/scaffolder.test.ts` for any `GENERACY_CLOUD_URL` references and update

## Phase 4: Verification & Follow-up

- [ ] T010 [US1] Run SC-001 verification — execute `rg GENERACY_CLOUD_URL src/` across all three packages and confirm zero hits (test files may contain the string only in negative assertions)
- [ ] T011 [P] File follow-up GitHub issue for removing `--cloud-url` hidden alias after one release cycle
- [ ] T012 [P] File companion GitHub issue in generacy-cloud repo for `LaunchConfig.cloudUrl` deprecated field removal

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 → Phase 2 → Phase 3 → Phase 4

**Parallel opportunities within phases**:
- Phase 1: T001, T002, T003 can all run in parallel (different packages, no shared files)
- Phase 2: T004, T005, T006 can all run in parallel (different files)
- Phase 3: T007, T008, T009 can all run in parallel (different test files)
- Phase 4: T010 must run first (verification gate), then T011 and T012 can run in parallel

**Key dependencies**:
- T007 depends on T001 (tests must match updated `cloud-url.ts`)
- T008 depends on T002 (tests must match updated `loader.ts`)
- T005, T006 depend on T001 (flag handler calls `resolveApiUrl`)
- T010 depends on all prior tasks (verification sweep)
