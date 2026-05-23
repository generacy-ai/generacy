# Tasks: Restore `.env` `WORKER_COUNT` sync + CLI re-derivation

**Input**: Design documents from `/specs/708-problem-706-https-github/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup

- [X] T001 Confirm `packages/control-plane/__tests__/services/worker-scaler.test.ts` exists and identify the surrounding test helpers (tmp-dir setup, atomicWrite mock points) so new cases can be added with the same fixtures.
- [X] T002 [P] Confirm `packages/generacy/src/cli/commands/up/__tests__/` and `packages/generacy/src/cli/commands/update/__tests__/` exist; create the directories if missing so command tests have a home.
- [X] T003 [P] Re-read pre-#706 `.env` writer in `worker-scaler.ts` via `git show 4b7876f -- packages/control-plane/src/services/worker-scaler.ts` to confirm the exact regex (`/^WORKER_COUNT=\d+$/m`) and append-when-missing pattern that the new code must match.

## Phase 2: Core — CLI Re-derivation Helper (US2)

- [X] T010 [US2] Create `packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts` with:
  - Exported `DeriveResult` / `SyncEnvResult` interfaces matching `contracts/worker-count-deriver.md`.
  - `deriveWorkerCount(generacyDir, logger)`: read `<generacyDir>/cluster.yaml` via `yaml.parse`, inspect `workers` against the narrow `z.object({ workers: z.unknown() }).partial()` schema, apply FR-009 (clamp 0/negative integer → 1) and FR-010 (any other shape → default 1) rules, return `{ workerCount, source, warnings }`. Pure read; never throws on missing/malformed/unreadable input.
  - `syncEnvWorkerCount(generacyDir, workerCount, logger)`: if `.env` missing → return `{ wrote: false, reason: 'env-missing' }` (no file created); else in-place replace `/^WORKER_COUNT=.*$/m` or append `WORKER_COUNT=<N>`; atomic temp+rename in the same directory; on write error log warning and return `{ wrote: false, reason: 'write-failed', error }`. Never throws.
  - `reconcileWorkerCount(generacyDir, logger)`: composes `deriveWorkerCount` → if `source !== 'cluster.yaml'`, atomically rewrite `cluster.yaml` with `workers: <workerCount>` (full-doc read → mutate `workers` only → `yaml.stringify`) → `syncEnvWorkerCount`. Logs all warnings via `logger.warn` with the exact wording from research.md §D7. Returns `{ workerCount, envWrote }`. Never throws.

- [X] T011 [US2] Create `packages/generacy/src/cli/commands/cluster/__tests__/worker-count-deriver.test.ts` with tmp-dir-backed Vitest cases covering every row of the data-model.md FR-009/FR-010 table plus `syncEnvWorkerCount` paths:
  - `deriveWorkerCount`: positive integer (5), `0`, negative (`-3`), non-integer number (`1.5`), string (`"five"`), `null`, array, object, missing key, missing file, unreadable file (permission denied if practical, else corrupt YAML).
  - `syncEnvWorkerCount`: in-place replace preserves all other lines byte-for-byte; append when no `WORKER_COUNT=` line; skip-and-warn when `.env` missing; write-failed path when temp dir is unwritable.
  - `reconcileWorkerCount`: idempotency (running twice on a malformed yaml self-heals on the first call, no-op on the second); cluster.yaml self-heal preserves other keys (`channel`, `variant`, `appConfig`).

## Phase 3: Core — Orchestrator `.env` Sync in `worker-scaler.ts` (US1)

- [X] T020 [US1] Modify `packages/control-plane/src/services/worker-scaler.ts` `doScale()`:
  - After the successful `updateClusterYaml(yamlPath, actualCount)` call, derive `envPath = join(generacyDir, '.env')` and invoke a new private `syncEnvWorkerCountInScaler(envPath, actualCount)` helper.
  - Wrap the call in `try/catch`: on `ENOENT` (file missing) emit `console.warn` with the exact text from research.md §D7 (`WORKER_COUNT sync to .env skipped: file not found at <path>`) and continue. On any other error emit `console.warn` with `WORKER_COUNT sync to .env failed: <error.message>; cluster.yaml is the source of truth` and continue. Never re-throw; the scale operation's return value is unchanged.
  - Implement the new private `syncEnvWorkerCountInScaler(envPath, count)` helper inside the same file: stat → `ENOENT` throws to caller for the skip path; read → in-place regex replace (`/^WORKER_COUNT=.*$/m`) or append; write via the existing `atomicWrite` helper (lines ~529–533).

- [X] T021 [US1] Extend `packages/control-plane/__tests__/services/worker-scaler.test.ts` with the cases enumerated in research.md §D8.1:
  - Scale to N when `.env` exists with `WORKER_COUNT=M` (M ≠ N) → `.env` shows `WORKER_COUNT=N`, all other lines preserved.
  - Scale to N when `.env` exists without a `WORKER_COUNT` line → line appended.
  - Scale to N when `.env` does NOT exist → no file created, warning emitted, `doScale` resolves normally.
  - Scale to N when the env-write throws (mock the atomicWrite call site or stat) → scale result unchanged, warning logged.
  - Write order: cluster.yaml stays updated when the `.env` write throws after a successful `updateClusterYaml`.

## Phase 4: Integration — Wire deriver into `up` and `update` (US2)

- [X] T030 [US2] Modify `packages/generacy/src/cli/commands/up/index.ts`:
  - Import `reconcileWorkerCount` from `../cluster/worker-count-deriver`.
  - Call `reconcileWorkerCount(generacyDir, logger)` immediately after resolving `generacyDir` and BEFORE `getClusterContext()` (so a clamped/defaulted cluster.yaml is self-healed before the strict schema parses it).
  - On a non-`cluster.yaml` source, surface a single info-level log line via the existing logger (do not double-log warnings — the deriver already logs them).
  - Failures from `reconcileWorkerCount` are impossible by contract; no try/catch needed.

- [X] T031 [US2] Modify `packages/generacy/src/cli/commands/update/index.ts`:
  - Identical wiring as T030: import `reconcileWorkerCount`, call it after resolving `generacyDir` and BEFORE `getClusterContext()`, ahead of both `runCompose(ctx, ['pull'])` and `runCompose(ctx, ['up', '-d'])`.

- [X] T032 [P] [US2] Add `packages/generacy/src/cli/commands/up/__tests__/reconcile.test.ts` (or extend an existing up test file) with `runCompose`-stubbed cases:
  - `cluster.yaml` `workers: 5` + `.env` `WORKER_COUNT=1` → `.env` is `WORKER_COUNT=5` before `runCompose` is called.
  - `cluster.yaml` `workers: 0` → `.env` is `WORKER_COUNT=1`, `cluster.yaml` rewritten to `workers: 1`, warning logged.
  - `cluster.yaml` `workers: "five"` → same as above but with malformed-warning text.

- [X] T033 [P] [US2] Mirror T032 cases in `packages/generacy/src/cli/commands/update/__tests__/reconcile.test.ts`, additionally asserting reconciliation runs before `docker compose pull`.

## Phase 5: Polish

- [ ] T040 [P] Run the full quickstart.md verification block locally for SC-001, SC-002, SC-003, FR-008, FR-009, FR-010 against a real cluster, recording the observed worker counts and warning text in the PR description.
- [X] T041 [P] Run `pnpm test --filter @generacy-ai/control-plane worker-scaler` and `pnpm test --filter @generacy-ai/generacy worker-count-deriver` and `pnpm test --filter @generacy-ai/generacy "commands/up"` and `pnpm test --filter @generacy-ai/generacy "commands/update"`; all four suites must pass.
- [X] T042 Verify no new lints/type errors with `pnpm -w typecheck` (or the repo's standard CI command); resolve any incidental issues introduced by the new module's imports.

## Dependencies & Execution Order

**Sequential dependencies**:
- T001–T003 (setup) before all other phases.
- T010 (deriver module) blocks T011 (its tests), T030, T031, T032, T033 (consumers).
- T020 (worker-scaler edit) blocks T021 (its tests).
- T030, T031 (wiring) block T032, T033 (command tests) only logically; tests can be authored in parallel with the wiring but will fail until the wiring lands.
- T040–T042 (polish) require all core/integration tasks complete.

**Parallel opportunities**:
- T002 ‖ T003 (independent setup checks).
- T010 (deriver) ‖ T020 (worker-scaler) — different packages, no shared files. Authors can split US1 and US2 across two contributors.
- T011 ‖ T021 — independent test files in different packages.
- T032 ‖ T033 — different command test files; both depend only on T010/T030/T031.
- T040 ‖ T041 — manual verification vs automated test runs.

**Critical path**: T001 → T010 → T030 → T032 (or → T033) → T041 → T042.

**Story coverage**:
- US1 (cloud-UI scale survives compose re-up): T020, T021.
- US2 (hand-edited cluster.yaml wins over stale .env): T010, T011, T030, T031, T032, T033.
- Both stories share the polish phase (T040–T042).
