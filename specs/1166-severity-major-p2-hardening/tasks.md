# Tasks: Bugfix targeted-validate and fail-then-pass hardening

**Input**: Design documents from `/specs/1166-severity-major-p2-hardening/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Scope guardrails (read before starting)

- `packages/orchestrator/src/worker/diff-classifier.ts` is **UNCHANGED** — the pure
  `classifyDiff` stays no-I/O; all existence/zero-project probing lives in the wiring
  layer (`phase-loop.ts`), per clarification Q3=A.
- `config.ts` `DEFAULT_VALIDATE_COMMAND` is **UNCHANGED**; the `isBuiltInDefault`
  identity check remains the gate that keeps custom commands verbatim (except the new
  `<base>` substitution).
- Every new fall-back / skip / infra decision emits exactly **one** structured log line
  (FR-011), matching the existing `event: 'targeted-validate'` / `event: 'fail-then-pass'`
  shapes.
- Non-bugfix workflows and non-triggering bugfix runs must stay **byte-identical**
  (FR-012 / SC-007).

## Phase 1: Setup

- [ ] T001 Confirm the two target files and their touch-points before editing:
  `packages/orchestrator/src/worker/phase-loop.ts` (`resolveTargetedValidate`,
  `computeEffectiveValidateCommand`) and
  `packages/orchestrator/src/worker/fail-then-pass.ts` (`runFailThenPass`, `runTests`,
  worktree `finally`). Verify the existing test-mock seam: suites mock
  `node:child_process` via an `execFile` router keyed on `cmd`/`args` plus
  `node:fs/promises`.

## Phase 2: Core Implementation — fail-then-pass prover (`fail-then-pass.ts`)

These tasks all edit the same file (`fail-then-pass.ts`), so they are **sequential** (no [P]).

- [ ] T002 [US3] Add the conservative `isInfraFailure(output: string): boolean` pure
  predicate in `packages/orchestrator/src/worker/fail-then-pass.ts`. Returns `true` ONLY
  for a pre-collection failure (vitest collected/ran zero tests): `No test files found`,
  or a module/dist-resolution error before any test runs (`Cannot find module`,
  `Failed to resolve import`, `Failed to load url`, `ERR_MODULE_NOT_FOUND`) with no run
  test lines. Returns `false` for any collected-and-failed test (`FAIL`, per-test `×`/`✓`
  lines, `Tests  N failed`/`N passed`) and for anything ambiguous — bias to genuine
  (Q2=A). See `data-model.md` signal table.

- [ ] T003 [US3] Wire the infra signature into the base and branch outcome branches
  (`fail-then-pass.ts:94-110, 211`). After the **base** run:
  `!baseOutcome.passed && isInfraFailure(baseOutcome.output)` →
  `{ kind: 'skip', reason: 'infra:<signature> at base ref' }` (never `base-passed`).
  After the **branch** run: same predicate →
  `{ kind: 'skip', reason: 'infra:<signature> on branch' }` (covers FR-005 no-root-vitest).
  Genuine base pass still → `fail: base-passed`; genuine branch failure still →
  `fail: branch-failed`. No build step added (FR-004/FR-005; Q1=A).

- [ ] T004 [US3] Add the `BASE_TEST_TIMEOUT_MS = 5 * 60_000` constant (mirroring
  `BASE_INSTALL_TIMEOUT_MS`) and apply it as `{ timeout: BASE_TEST_TIMEOUT_MS }` on each
  `runTests` `execFile` call (base and branch). Add `timedOut: boolean` to
  `TestRunOutcome`; `runTests` sets it when the rejection is a timeout kill
  (`err.killed === true` / `code === 'ETIMEDOUT'`), NOT when it is an `AbortError` from
  the phase `signal` (which must propagate). A timed-out run maps to
  `{ kind: 'skip', reason: 'timeout' }` (FR-006).

- [ ] T005 [US4] Fix the worktree lifecycle (`fail-then-pass.ts:162-199`). Capture the
  `mkdtemp` parent: `const tmpParent = await mkdtemp(join(tmpdir(), 'gen-ftp-'))`,
  `const worktreePath = join(tmpParent, 'wt')`. In `finally`, run each step best-effort,
  **without the abort signal**, guarded so one failure does not skip the next:
  (1) `git worktree remove --force <worktreePath>`, (2) `git worktree prune`,
  (3) `rm(tmpParent, { recursive: true, force: true })` (FR-007/FR-008).

- [ ] T006 [US4] Wrap the `git worktree add` in try/catch (`fail-then-pass.ts:167-170`);
  on failure return `{ kind: 'skip', reason: 'worktree-add-failed' }` instead of throwing.
  The `finally` still runs (cleanup + prune handle a partially-created worktree); the
  caller `runFailThenPassCheck` already treats `skip` as "proceed to normal validate"
  (FR-009).

- [ ] T007 [US3][US4] Emit one structured `event: 'fail-then-pass'` log line for each new
  skip decision (`outcome: 'skip'` with `reason` one of `infra:*`, `timeout`,
  `worktree-add-failed`), consistent with the existing install-failure/fail log lines
  (FR-011).

## Phase 3: Core Implementation — targeted-validate wiring (`phase-loop.ts`)

These tasks all edit the same file (`phase-loop.ts`), so they are **sequential** (no [P]).
Independent of Phase 2 (different file) — Phase 2 and Phase 3 may proceed in parallel across
files, but the tasks *within* each phase are ordered.

- [ ] T008 [US1] Existence-filter the diff set in `resolveTargetedValidate`
  (`phase-loop.ts`, between `getFilesChangedBetween` and `classifyDiff`):
  `changedFiles = changedFiles.filter((f) => existsSync(join(context.checkoutPath, f)))`.
  Store the filtered set on `TargetedValidateDecision.changedFiles` so the fail-then-pass
  caller (`changedFiles.filter(isTestFile)`) also sees only present paths. An all-filtered
  deletion-only diff → empty set → `classifyDiff` returns `full-fallback('empty-diff')`
  → full built-in default (FR-001/FR-002, no extra branch needed).

- [ ] T009 [US2] Add the zero-project probe + fallback in `resolveTargetedValidate`, after
  `classifyDiff`, gated on `isBuiltInDefault === true` AND a classification that would emit
  a `pnpm --filter "...[origin/<base>]"` command (`targeted`, `docs-only-skip-tests`).
  Probe `pnpm --filter "...[origin/<base>]" --depth -1 --json` (or `pnpm ls --filter …`)
  in `context.checkoutPath`. Empty selection → override effective command to the full
  built-in default. Probe error → also fall back to full (fail-safe). Route the probe
  through the same `execFile` path the tests mock — no new production DI surface
  (FR-003; research Decision 3/7).

- [ ] T010 [US5] Add `<base>` substitution in `computeEffectiveValidateCommand`: for a
  custom (non-built-in-default) `validateCommand`,
  `effectiveCommand = validateCommand.replace(/<base>/g, base)` where
  `base = baseRef.replace(/^origin\//, '')`. Resolve `base` before the diff computation so
  the substitution is available even on the diff-resolution-failure early-return path (a
  `<base>` command is never emitted with the literal placeholder). Mirrors the existing
  merge-conflict `<base>`/`<branch>` substitution (FR-010; Q4=A).

- [ ] T011 [US2] Emit one `event: 'targeted-validate'` info log line on the zero-project
  fallback with `reason: 'zero-project-fallback'` and the full command it fell back to,
  consistent with the existing `#1134: targeted-validate decision` line. The `empty-diff`
  full-fallback path reuses the existing decision log line (no new line needed) (FR-011).

## Phase 4: Documentation

- [ ] T012 [P] [US5] Update `docs/docs/reference/bugfix-profile-config.md`: replace the
  hardcoded `origin/develop` in the custom `validateCommand` example with `origin/<base>`,
  and explain that `<base>` is substituted with the resolved base branch at validate time
  (works on both `develop`- and `main`-based repos). Under `docs/`, not `packages/*/src/`
  — does not itself trigger the changeset gate (FR-010; SC-006).

## Phase 5: Tests

- [ ] T013 [US3][US4] Add fail-then-pass tests in
  `packages/orchestrator/src/worker/__tests__/fail-then-pass.test.ts`, routing runs through
  the existing `execFile` mock router:
  - Base-ref infra signature (`No test files found` / dist-resolution error, zero tests) →
    `skip` with logged `infra:*` reason, never `base-passed`/`branch-failed` (SC-003).
  - No-root-vitest branch run collects zero tests → `skip`, not a false `branch-failed`
    (FR-005/SC-003).
  - A collected-and-failed test is NOT masked as infra → still a genuine outcome.
  - Hung run hits `BASE_TEST_TIMEOUT_MS` → `skip: timeout`; `AbortError` propagates and is
    NOT converted to a spurious finding (SC-004).
  - `mkdtemp` parent dir removed on success/error/abort paths; `git worktree prune` runs
    signal-free; `git worktree list` clean afterward (SC-005).
  - `git worktree add` failure → `skip: worktree-add-failed`, not a hard phase failure
    (FR-009).

- [ ] T014 [US1][US2][US5] Add/extend targeted-validate wiring tests in
  `packages/orchestrator/src/worker/__tests__/phase-loop.*.test.ts` (new or extended
  `phase-loop` suite), routing the `pnpm --filter … --json` probe and each `pnpm vitest
  run` through the shared `execFile` handler:
  - Deletion-only test diff → all paths filtered out → full fallback; no
    `pnpm vitest run <nonexistent-file>` ever emitted (SC-001).
  - Rename (old deleted, new added) → validate never references the old path (SC-001).
  - Test-only diff whose files all still exist → runs exactly those files (unchanged, SC-007).
  - Root-only non-config diff (root `package.json` / `scripts/**` / root
    `vitest.config.ts`) that classifies `targeted` but selects zero projects → falls back
    to full; probe error also falls back to full (SC-002).
  - Custom `validateCommand` with `<base>` → substituted with the resolved base branch on
    both `develop`- and `main`-based fixtures; built-in default path unchanged (SC-006).

## Phase 6: Verification & Polish

- [ ] T015 Add the changeset `.changeset/1166-bugfix-validate-hardening.md`:
  `@generacy-ai/orchestrator` **patch** (`workflow:speckit-bugfix` defect fix; no new
  public exports). Must be a newly added file. The `docs/` edit and test-only files are
  exempt, but the `.ts` changes to `phase-loop.ts` / `fail-then-pass.ts` require this
  changeset (per CLAUDE.md changeset gate).

- [ ] T016 Run the affected suites and confirm green plus no regression (SC-007):
  `pnpm --filter @generacy-ai/orchestrator test fail-then-pass` and
  `pnpm --filter @generacy-ai/orchestrator test phase-loop`. Confirm existing
  validate/classifier suites remain green and `diff-classifier.ts` is untouched in the diff.

## Dependencies & Execution Order

**Setup first**: T001 precedes all implementation.

**Two independent core tracks (different files → can run concurrently across the two files)**:
- **Track A — `fail-then-pass.ts`**: T002 → T003 → T004 → T005 → T006 → T007 (sequential;
  same file). T002 (`isInfraFailure`) must land before T003 (which consumes it).
- **Track B — `phase-loop.ts`**: T008 → T009 → T010 → T011 (sequential; same file). T008
  (existence filter) establishes the filtered `changedFiles` that T009's probe and the
  fail-then-pass caller rely on.

**Docs**: T012 [P] is fully independent (different file) — can run anytime.

**Tests** (Phase 5) depend on their respective implementation tracks:
- T013 depends on Track A (T002–T007).
- T014 depends on Track B (T008–T011) and T010's `<base>` substitution.

**Verification** (Phase 6): T015 (changeset) can be written once the `.ts` files are
touched; T016 runs last, after all implementation and tests.

**Parallel opportunities**:
- Track A and Track B edit different files and share no state at implementation time →
  can be developed in parallel.
- T012 (doc) is parallel with everything.
- T013 and T014 target different test files → parallel once their tracks land.

## Next Step

Run `/speckit:implement` to begin execution.
