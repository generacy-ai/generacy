# Tasks: Add `--cloud-url` flag to CLI commands

**Input**: Design documents from `/specs/545-problem-generacy-launch-reads/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Shared Helper + Tests

- [ ] T001 [US1] Create `resolveCloudUrl()` helper in `packages/generacy/src/cli/utils/cloud-url.ts` — 3-tier resolution (flag > `GENERACY_CLOUD_URL` env > `https://api.generacy.ai`), Zod `z.string().url()` validation, descriptive error on invalid URL
- [ ] T002 [US1] Create unit tests in `packages/generacy/src/cli/utils/__tests__/cloud-url.test.ts` — test flag wins over env and default, env wins over default, default when neither set, invalid URL throws, env var with flag override

## Phase 2: Command Integration

- [ ] T003 [US1] Wire `--cloud-url` into launch command (`packages/generacy/src/cli/commands/launch/index.ts`) — add `.option('--cloud-url <url>', ...)`, replace inline `process.env['GENERACY_CLOUD_URL'] ?? 'https://api.generacy.ai'` with `resolveCloudUrl(options.cloudUrl)`
- [ ] T004 [P] [US2] Wire shared helper into deploy command (`packages/generacy/src/cli/commands/deploy/index.ts`) — replace `options.cloudUrl ?? DEFAULT_CLOUD_URL` with `resolveCloudUrl(options.cloudUrl)`, remove unused `DEFAULT_CLOUD_URL` constant if applicable

## Phase 3: Verification

- [ ] T005 [US3] Run existing tests to verify no regressions — `pnpm --filter @generacy-ai/generacy test`
- [ ] T006 [US1] Verify TypeScript compiles — `pnpm --filter @generacy-ai/generacy build` (or `tsc --noEmit`)

## Dependencies & Execution Order

1. **T001** must complete first (shared helper is a dependency for all other tasks)
2. **T002** can run immediately after T001 (tests validate the helper)
3. **T003** and **T004** are independent of each other (different files) and can run in parallel after T001
4. **T005** and **T006** run after T003+T004 to verify the full integration
