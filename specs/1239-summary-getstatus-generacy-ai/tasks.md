# Tasks: getStatus rename/copy entries break staging and silently lose phase work

**Input**: Design documents from `/specs/1239-summary-getstatus-generacy-ai/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Parser fix — workflow-engine (US1)

- [X] T001 [US1] In `packages/workflow-engine/src/actions/github/client/gh-cli.ts`
  (`getStatus()`, ~:1315), change the status invocation from line-split
  `git status --porcelain` to NUL-split
  `git status --porcelain -z --untracked-files=all`. Split stdout on `\0` and drop
  the trailing empty token. (FR-001, FR-003 — keep `--untracked-files=all`, #1162.)

- [X] T002 [US1] In the same `getStatus()` parser, walk the NUL token stream with an
  index instead of `for … of lines`. Per entry: `X = entry[0]`, `Y = entry[1]`,
  dest = `entry.slice(3)`. When `X === 'R' || X === 'C' || Y === 'R' || Y === 'C'`,
  consume the **next** token as the source path. Classify per data-model.md:
  `?? → untracked.push(dest)`; `X ∉ {' ','?'} → staged.push(dest)` (and source if
  `X ∈ {R,C}`); `Y ∉ {' ','?'} → unstaged.push(dest)` (and source if `Y ∈ {R,C}`).
  Set `has_changes` from the **entry** count (a rename is one entry), not raw token
  count. (FR-001, FR-002, FR-004.)

- [X] T003 [US1] Verify `getStatus()`'s unpushed-commit detection
  (branch → status → rev-list sequence) is unchanged by the tokenization switch;
  the status read now returns `-z` output but `hasUnpushed`/`unpushedCount` logic
  must behave identically. (FR-003.)

## Phase 2: Error surfacing — orchestrator (US2)
<!-- Phase boundary: Complete Phase 1 (parser) before wiring the commit-error outcome -->

- [X] T004 [US2] In `packages/orchestrator/src/worker/pr-manager.ts` (~:18) add the
  `{ kind: 'commit-error'; message: string }` variant to the private
  `CommitAndPushOutcome` union. (FR-005, data-model.md.)

- [X] T005 [US2] In `PrManager.commitAndPush` (`pr-manager.ts`, ~:127) wrap **only**
  the `getStatus` → sidecar/agent-context filtering → `stageFiles` → `commit` span
  (~:151-191) in an inner try/catch that returns
  `{ kind: 'commit-error', message }`. Leave `revertPaths`, remote-branch queries,
  push guard, and push under the existing outer catch so they still collapse to
  `no-changes` (Q2: A, FR-005).

- [X] T006 [US2] In `commitPushAndEnsurePr` short-circuit the `commit-error` outcome
  **before** `ensureDraftPr`, returning `{ hasChanges: false, commitError: { message } }`,
  mirroring the existing `refused` short-circuit. (FR-005, research.md R4.)

- [X] T007 [P] [US2] In `packages/orchestrator/src/worker/types.ts` (~:573) add the
  optional `commitError?: { message: string }` field to `CommitResult`, beside
  `pushRefused` (mutually exclusive; when present `hasChanges` is false). (FR-005.)

- [X] T008 [US2] In `packages/orchestrator/src/worker/phase-loop.ts` add a parallel
  `outcome.commitError` check at **every** site that checks `outcome.pushRefused`:
  main completion (~:1630), WIP/pause (~:1134, ~:2557), partial (~:1326),
  retry (~:1369), remediate (~:1532, ~:2365). Each gets the same control-flow exit
  (abort, `completed: false`, no `onPhaseComplete`, no advancement) with a distinct
  log message naming the commit-error reason; normal retry policy then applies
  (Q1: A). Grep `pushRefused` in this file to confirm no site is missed. (FR-005.)

## Phase 3: Tests
<!-- Phase boundary: implementation (Phase 1 + 2) must land before pinning tests -->

- [X] T009 [P] [US1] Update mocked status fixtures in
  `packages/workflow-engine/src/actions/github/client/__tests__/gh-cli.get-status.test.ts`
  and `packages/workflow-engine/tests/actions/github/unpushed-detection.test.ts`
  from `\n`-separated to `\0`-separated stdout, and assert the new invocation
  `['status', '--porcelain', '-z', '--untracked-files=all']`. (SC-003, risk: fixture churn.)

- [X] T010 [US1] Extend `gh-cli.get-status.test.ts` with new cases feeding simulated
  `-z` output containing `R `, `RM`, ` M`, `??`, and a path with spaces; assert real
  paths, no `->` substring anywhere, and that source + dest are both present in the
  right list(s). (SC-002.)

- [X] T011 [P] [US1] Add new integration test
  `packages/workflow-engine/src/actions/github/client/__tests__/gh-cli.rename-status.test.ts`
  following the `gh-cli.revert-paths.test.ts` temp-repo pattern (`mkdtempSync` +
  `execFileSync('git', …)` with `user.email`/`user.name`/`commit.gpgsign=false`):
  `git mv old.ts new.ts` + append (yields `RM`) plus a plain ` M` file; run
  `getStatus()` → `stageFiles(status lists)` → `commit(…)`; assert the commit contains
  **both** source and destination paths and the tree is clean. (SC-001, Q3: B.)

- [X] T012 [P] [US2] Add pr-manager unit tests under
  `packages/orchestrator/src/worker/__tests__/`: a throwing `stageFiles`/`commit`
  mock yields `commitError` and does NOT call `ensureDraftPr`; a throwing `push` mock
  still yields the non-fatal `no-changes` behavior. (FR-005.)

- [X] T013 [P] [US2] Add a phase-loop abort test mirroring the existing `pushRefused`
  abort test (`phase-loop.manual-validation.test.ts:266` pattern): a `commitError`
  outcome aborts the phase (`completed: false`, no `onPhaseComplete`, no advancement).
  (FR-005.)

## Phase 4: Verification

- [X] T014 Add changeset `.changeset/1239-getstatus-rename-parsing.md` at `patch`,
  listing **both** `@generacy-ai/workflow-engine` and `@generacy-ai/orchestrator`
  (non-test `src/` changed in both; bugfix). Must be a newly added file. (CLAUDE.md
  changeset gate.)

- [X] T015 Rebuild `@generacy-ai/workflow-engine` `dist/` before typechecking/testing
  orchestrator (orchestrator imports the built output), then run
  `pnpm --filter @generacy-ai/workflow-engine test` and the orchestrator suite;
  confirm the real-repo tests (`get-status-untracked-dir.integration.test.ts`,
  `gh-cli.revert-paths.test.ts`) pass unmodified. (SC-003, build-order invariant.)

## Dependencies & Execution Order

**Phase boundaries (sequential):**
- Phase 1 (parser) → Phase 2 (error surfacing) → Phase 3 (tests) → Phase 4 (verification).
- Parser must land before the rename-status integration test (T011) can pin real
  `getStatus → stageFiles → commit` behavior; the orchestrator outcome must land before
  the pr-manager/phase-loop tests (T012, T013).

**Within-phase ordering:**
- Phase 1: T001 → T002 (same function, sequential); T003 verifies after.
- Phase 2: T004 → T005 → T006 (same file/flow, sequential); T007 [P] is in a separate
  file (`types.ts`) and can proceed in parallel; T008 depends on T004/T007.

**Parallel opportunities [P]:**
- T007 (types.ts) parallel with T004–T006 (pr-manager.ts).
- T009, T011 (workflow-engine tests) parallel with T012, T013 (orchestrator tests) —
  different packages, no shared files. T010 follows T009 (same file).

**Changeset & build (Phase 4):** T014 can be written any time after the package set is
known; T015 is the final gate and depends on all prior tasks.
