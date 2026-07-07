# Tasks: `cockpit watch` must survive its own poll interval

**Input**: Design documents from `/specs/836-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = operator, US2 = CI regression protection)

## Phase 1: Regression Test First (red)

- [ ] T001 [US2] Create subprocess regression test at `packages/generacy/src/cli/commands/cockpit/__tests__/watch-subprocess.test.ts`:
  - Spawn compiled CLI: `node dist/bin/generacy.js cockpit watch <fixture-epic-ref>` via `node:child_process.spawn`.
  - Fixture: a stable closed issue in `generacy-ai/generacy` (pick a low-noise reference; e.g., an already-closed issue in this repo). Skip the test locally when `process.env.CI == null && process.env.GH_TOKEN == null` (`describe.skipIf(...)`); rely on CI `GH_TOKEN` otherwise.
  - Listen on child stderr for the `cockpit watch: epic ` startup line; resolve a promise when it appears. Timeout 15 s for the startup line (network + `gh` resolution).
  - After the startup line, `await new Promise(r => setTimeout(r, 5000))`.
  - Assert `child.exitCode === null && child.killed === false`.
  - `child.kill('SIGTERM')`; await the `close` event; assert exit code is `0`.
  - Do NOT inject `abortSignal`. Do NOT run in-process (`runWatch` + `onTick`) — per D2, vitest handles mask the drain.
  - Do NOT add the optional white-box `hasRef()` assertion (Q1: allowed but not required).

- [ ] T002 [US2] Run the new test against the current (unfixed) code and confirm it FAILS the "still alive after 5 s" assertion. This proves the regression gate has real signal. Command: `pnpm --filter @generacy-ai/generacy build && pnpm --filter @generacy-ai/generacy test -- watch-subprocess`. Do NOT commit any workaround that makes the buggy code pass this test.

## Phase 2: Fix (green)

- [ ] T003 [US1] In `packages/generacy/src/cli/commands/cockpit/watch.ts`, in the `sleep()` helper (currently lines 48-61), remove the line `timer.unref?.();` (line 55). Immediately above `const timer = setTimeout(resolve, ms);`, add a one-line comment referencing this issue and the constraint from FR-002:

  ```ts
  // Do not unref — see #836. An embedder that needs an unref'd timer must gate
  // it behind an explicit WatchDeps flag the CLI never sets.
  const timer = setTimeout(resolve, ms);
  ```

  Do not modify anything else: `WatchDeps` shape unchanged, abort listener wiring unchanged, `runOnePoll`/`snapshot.ts`/`emit.ts`/`resolver.ts` untouched. No `WatchDeps.unrefTimer` flag (Q2: deferred).

## Phase 3: Verify

- [ ] T004 [US2] Rebuild and re-run the subprocess test; assert it now PASSES (`pnpm --filter @generacy-ai/generacy build && pnpm --filter @generacy-ai/generacy test -- watch-subprocess`). Runtime ≤ ~10 s per SC-002.

- [ ] T005 [P] [US1] Run the full watcher unit-test suite and confirm no regression: `pnpm --filter @generacy-ai/generacy test -- watch`. All existing `watch.test.ts`, `watch.diff.test.ts`, `watch.emit.test.ts`, `watch.epic-walk.test.ts`, `watch.pagination.test.ts`, `watch.poll-loop.test.ts`, `watch.no-mutations.test.ts`, `watch.check-rollup.test.ts` cases must remain green (SC-003).

- [ ] T006 [P] [US1] Manual smoke test per `quickstart.md` SC-001:
  ```bash
  pnpm --filter @generacy-ai/generacy build
  timeout 75 node packages/generacy/dist/bin/generacy.js cockpit watch <owner>/<repo>#<n> </dev/null; echo "exit: $?"
  ```
  Expect `exit: 124` (killed by `timeout`), NOT `exit: 0`. Confirms the process survives past the 30 s default interval.

- [ ] T007 [P] [US1] Manual end-to-end smoke test per `quickstart.md` SC-004: run `node packages/generacy/dist/bin/generacy.js cockpit watch <owner>/<repo>#<n>` against a live epic; in another terminal, add or remove a label on a child issue; verify at least one NDJSON transition line is emitted within one interval; Ctrl-C and verify clean exit within one interval (FR-003).

## Dependencies & Execution Order

**Sequential**:
- T001 → T002 (test must exist to be run red)
- T002 → T003 (fix only after test is proven red — regression signal must be real)
- T003 → T004 (rebuild and confirm green after fix)

**Parallel within Phase 3** (after T004 is green):
- T005, T006, T007 all touch independent verification surfaces and can run in parallel.

**Story mapping**:
- US1 (operator use) drives T003 (the fix), T005/T006/T007 (verification of operator-facing behavior).
- US2 (CI regression protection) drives T001, T002, T004 (the regression test lifecycle).

**Total tasks**: 7 (2 test lifecycle, 1 fix, 4 verification of which 3 are parallel).

**Next step**: `/speckit:implement` to execute this task list.
