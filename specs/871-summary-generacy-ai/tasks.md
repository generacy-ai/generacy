# Tasks: Close the orchestrator + generacy CI test-coverage blind spot

**Input**: Design documents from `/specs/871-summary-generacy-ai/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/ci-jobs.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = merge-gate visibility, US2 = infra-dependent tests keep gating)

## Phase 1: Setup — vitest integration config + filename convention

Establishes the `*.integration.test.ts` split. Must land before Phase 4 renames pick up the new config, and before Phase 5 flips the CI wiring.

- [ ] T001 [US2] Create `vitest.integration.config.ts` at repo root with `include: ['**/*.integration.test.ts']`, `environment: 'node'`, `testTimeout: 30000` (per `contracts/ci-jobs.md` §"New integration config (root)").
- [ ] T002 [P] [US2] Modify root `vitest.config.ts` to add `exclude: ['**/*.integration.test.ts']` alongside the existing `include: ['tests/**/*.test.ts']`.
- [ ] T003 [P] [US2] Modify `packages/orchestrator/vitest.config.ts` to add `exclude: ['**/*.integration.test.ts']`.
- [ ] T004 [P] [US2] Modify `packages/generacy/vitest.config.ts` to add `exclude: ['**/*.integration.test.ts']`.
- [ ] T005 [P] [US2] Add `"test:integration": "vitest --config ../../vitest.integration.config.ts run"` script to `packages/orchestrator/package.json`.
- [ ] T006 [P] [US2] Add `"test:integration": "vitest --config ../../vitest.integration.config.ts run"` script to `packages/generacy/package.json` (script exists, resolves 0 files today — required so `pnpm -r --if-present run test:integration` is symmetric).

## Phase 2: Orchestrator remediation — Group A (Redis-dependent, rename to `*.integration.test.ts`)

Requires T001–T003. All three files can be renamed in parallel — they are independent files.

- [ ] T010 [P] [US2] Rename `packages/orchestrator/src/services/__tests__/relay-bridge.test.ts` → `relay-bridge.integration.test.ts` (Group A: 4 tests — decorate sseManager.broadcast; send metadata on connect; send metadata periodically; handle metadata collection errors gracefully).
- [ ] T011 [P] [US2] Rename `packages/orchestrator/src/__tests__/relay-integration.test.ts` → `relay-integration.integration.test.ts` (Group A: 1 test — should forward SSE broadcast events through relay).
- [ ] T012 [P] [US2] Rename `packages/orchestrator/src/__tests__/server-relay-routes.test.ts` → `server-relay-routes.integration.test.ts` (Group A: 2 tests — passes /control-plane and /code-server routes to relay client; wires onStatusChange to trigger sendMetadata on running).
- [ ] T013 [US2] Verify renamed Group A files are excluded from the unit run: `pnpm --filter @generacy-ai/workflow-engine build && pnpm --filter @generacy-ai/orchestrator test` — Group A files must not appear in the run manifest.

## Phase 3: Orchestrator remediation — Groups B, C, D (fix in place, no infra)

All three groups touch different files and are fully parallelizable.

- [ ] T020 [P] [US1] Fix Group B: `packages/orchestrator/src/__tests__/health-code-server.test.ts` — add a valid `auth` block to the config fixture that satisfies the Zod schema at `packages/orchestrator/src/config/loader.ts` (root cause: `ZodError: [ "auth" ] Required` during suite setup).
- [ ] T021 [P] [US1] Fix Group C: `packages/orchestrator/src/activation/__tests__/poller.test.ts` — add `cloud_url` to approved-response fixtures (3 tests: returns approved response after pending; increases interval by 5s on slow_down; caps interval at 60s maximum). Schema source: `PollResponseSchema` in `packages/activation-client/src/types.ts` (#517).
- [ ] T022 [P] [US1] Fix Group C: `packages/orchestrator/src/activation/__tests__/activate.test.ts` — add `cloud_url` to approved-response fixtures (4 tests: full happy path; slow_down interval; expired + auto-retry; API key never appears in log output).
- [ ] T023 [P] [US1] Fix Group D: `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts` — refresh HTTP mock expectations to match the current call shape in `packages/orchestrator/src/services/webhook-setup-service.ts` (4 tests: list webhooks successfully; reactivate inactive webhooks + merge events; reactivate without changing events when issues already included; build correct PATCH request).
- [ ] T024 [US1] Verify orchestrator unit suite green: `pnpm --filter @generacy-ai/workflow-engine build && pnpm --filter @generacy-ai/orchestrator test` → 0 failed (SC-002 gate). Depends on T010–T012 (Group A out of unit) and T020–T023 (Groups B/C/D fixed).

## Phase 4: Generacy remediation — 36 failures across 15 files (fix in place)

Baseline measured at develop `33c9f11`. All are mock/CLI-assertion drift per Q4 = B. T030 is investigation-first; T031–T033 fix the known categories.

- [ ] T030 [US1] Run baseline to enumerate the exact 15 failing files: `pnpm --filter '@generacy-ai/generacy...' build && pnpm --filter @generacy-ai/generacy test 2>&1 | tee /tmp/generacy-baseline.log`. Extract the failing file list into the task ledger below.
- [ ] T031 [P] [US1] Fix "No `lifecycleAction` export is defined on the mock" (×5 files, per research.md Decision 4). For each offender, update the `vi.mock('...control-plane...')` factory to export the missing `lifecycleAction` symbol. Enumerate the exact 5 files from T030's output before starting.
- [ ] T032 [P] [US1] Fix CLI-output string drift (init, validate, placeholders, destroy, workspace-setup commands). Update each test's expected-output string to match current CLI output; do not "fix" the CLI to match stale test strings. Files enumerated by T030.
- [ ] T033 [P] [US1] Fix "AgentLauncher is not a constructor" — the mocked constructor no longer exists in source. Update the failing test's mock to match the current `AgentLauncher` export shape from `packages/orchestrator/src/launcher/index.ts` (or wherever it now lives). Files enumerated by T030.
- [ ] T034 [P] [US1] Any residual generacy failures uncovered by T030 that don't fit T031–T033 categories: fix in place per Q4 = B unless genuinely infra-bound. Genuinely infra-bound files: rename to `*.integration.test.ts` per FR-010 (expected empty — flag if hit).
- [ ] T035 [US1] Verify generacy unit suite green: `pnpm --filter '@generacy-ai/generacy...' build && pnpm --filter @generacy-ai/generacy test` → 0 failed (SC-003 gate). Depends on T030–T034.

## Phase 5: CI wiring — drop exclusions + add blocking integration job

**Must land last.** Flipping the wiring before T024 + T035 pass would turn `develop` red. All CI changes are in one file so they must be sequenced, not parallelized.

- [ ] T040 [US1] Modify `.github/workflows/ci.yml` `Test (packages)` step (line 52-53): drop both `--filter '!@generacy-ai/orchestrator'` and `--filter '!@generacy-ai/generacy'` — the step becomes `run: pnpm -r run --if-present test` (per `contracts/ci-jobs.md` §"Existing `ci` job"). Blocks on T024, T035.
- [ ] T041 [US2] Add new `integration` job to `.github/workflows/ci.yml` per the reference YAML in `contracts/ci-jobs.md` §"New `integration` job": `services: redis:7` with health-checked container on `localhost:6379`, standard checkout/pnpm/node-22 setup, `pnpm -r run --if-present build`, then `pnpm -r --if-present run test:integration`. **No `continue-on-error`.** Same trigger surface as the existing `ci` job. Blocks on T010–T012 (Group A renamed and functional against real Redis).

## Phase 6: Acceptance verification (against `specs/871-summary-generacy-ai/spec.md` Success Criteria)

Fast local gates before opening the PR. All are shell one-liners from `quickstart.md`.

- [ ] T050 [US1] **SC-001**: `grep -E "--filter '!@generacy-ai/(orchestrator|generacy)'" .github/workflows/ci.yml` returns nothing (exit code 1).
- [ ] T051 [US1] **SC-002**: `pnpm --filter @generacy-ai/workflow-engine build && pnpm --filter @generacy-ai/orchestrator test` — 0 failed.
- [ ] T052 [US1] **SC-003**: `pnpm --filter '@generacy-ai/generacy...' build && pnpm --filter @generacy-ai/generacy test` — 0 failed.
- [ ] T053 [US2] **SC-004**: `docker run --rm -d --name generacy-redis-test -p 6379:6379 redis:7 && pnpm -r --if-present run test:integration` — 0 failed. Tear down with `docker stop generacy-redis-test`.
- [ ] T054 [US1] **SC-005**: Sanity check that a deliberate `expect(1).toBe(2)` regression on a scratch branch turns the `ci` PR check red (do NOT merge). Confirms merge-gate visibility per US1.

## Dependencies & Execution Order

**Sequential phase boundaries**:
- Phase 1 (config split) → Phase 2 (Group A renames pick up the new `exclude`).
- Phases 2 + 3 + 4 → Phase 5 (CI wiring flip; landing before green would turn `develop` red).
- Phase 5 → Phase 6 (acceptance measures the after-state).

**Parallel opportunities**:
- **Phase 1**: T002–T006 all parallel after T001 lands (T001 is the config file every other task references).
- **Phase 2**: T010, T011, T012 all parallel (three independent renames); T013 blocks on all three.
- **Phase 3**: T020, T021, T022, T023 all parallel (four independent files); T024 blocks on all four *and* on T010–T012.
- **Phase 4**: T030 sequential first (enumeration); T031, T032, T033, T034 parallel after; T035 blocks on all.
- **Phase 5**: T040 and T041 both edit `.github/workflows/ci.yml` — sequence, don't parallelize.
- **Phase 6**: T050 (grep) and T051, T052, T053, T054 (test runs) are all independent — parallel after Phase 5.

**Critical path**: T001 → T003 → T010 → T024 → T040 → T051 → merge-eligible.

**Total tasks**: 26 (6 setup, 4 orchestrator Group A, 5 orchestrator Groups B/C/D, 6 generacy, 2 CI wiring, 5 verification, 2 rollup verify steps at T013 + T024/T035).

## Suggested next step

Run `/speckit:implement` to begin execution. First task: T001 (create `vitest.integration.config.ts`).
