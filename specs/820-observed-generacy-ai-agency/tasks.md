# Tasks: Fail loud when implement phase produces no product changes

**Input**: Design documents from `/specs/820-observed-generacy-ai-agency/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/product-diff.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = empty-implement detection; US2 = phase-loop-level enforcement)

## Phase 1: Foundation — interface extensions

The new check needs one new `GitHubClient` method and one new `PrManager` accessor. These are prerequisites for the helper module in Phase 2.

- [ ] T001 [US1] Extend `GitHubClient` interface with `getFilesChangedBetween(base: string, head: string): Promise<string[]>` in `packages/workflow-engine/src/actions/github/client/interface.ts` (per `data-model.md` §Extension to `GitHubClient` and `contracts/product-diff.md` §Module). JSDoc must state triple-dot / merge-base semantics. Empty result returns `[]`, never null/undefined.

- [ ] T002 [US1] Implement `GhCliGitHubClient.getFilesChangedBetween` in `packages/workflow-engine/src/actions/github/client/gh-cli.ts` via `executeCommand('git', ['diff', '--name-only', `${base}...${head}`], { cwd: this.workdir })`. Split stdout on `\n`, filter falsy lines. On non-zero exit throw an `Error` with `{ base, head, stderr }` in the message — do NOT swallow (`plan.md` §Implementation step 3, `Failure Modes & Mitigations` row 1). Depends on T001. If a `tokenProvider` is configured on the client (see #762 pattern in `gh-cli.ts`), thread it through the same way the other `git`-shelling methods do; if not, no env override is needed.

- [ ] T003 [P] [US1] Add `getPrNumber(): number | undefined` accessor to `PrManager` in `packages/orchestrator/src/worker/pr-manager.ts` (per `data-model.md` §Extension to `PrManager` and `contracts/product-diff.md` §`resolveBaseRef`). Returns cached `this.prNumber` set by `ensureDraftPr()` / `findPRForBranch()`; `undefined` before either has succeeded. Read-only getter — no side effects.

## Phase 2: New product-diff helper module

- [ ] T004 [US1] Create `packages/orchestrator/src/worker/product-diff.ts` exporting `EXCLUDED_PATH_PREFIXES` (`['specs/'] as const`), `isProductFile(path, prefixes?)`, `resolveBaseRef(github, prManager, owner, repo)`, `computeProductDiff(github, baseRef)`, and `ProductDiffResult` interface. All signatures and algorithms per `contracts/product-diff.md` §Exports. `isProductFile` uses `String.prototype.startsWith` — no glob, no regex, no path normalization (per FR-002 and Clarification Q4). `computeProductDiff` returns freshly-allocated arrays and does not mutate inputs (contract §Invariants for Test Writers). Depends on T001, T003.

- [ ] T005 [P] [US1] Add unit tests in `packages/orchestrator/src/worker/__tests__/product-diff.test.ts` covering:
  - `isProductFile`: `specs/foo.md` → false, `specs/README.md` → false, `README.md` → true, `packages/orchestrator/src/worker/phase-loop.ts` → true, `''` → true (edge case documented in contract).
  - `resolveBaseRef`: (a) when `prManager.getPrNumber()` returns a number, calls `github.getPullRequest(owner, repo, num)` and returns `origin/<pr.base.ref>`; (b) when getter returns `undefined`, calls `github.getDefaultBranch()` and returns `origin/<default>`, and does NOT call `getPullRequest`.
  - `computeProductDiff`: mock `github.getFilesChangedBetween`; assert `changedFiles`/`productFiles` partition and `baseRef` echo. Cover the primary SC-001 case (`changedFiles = ['specs/foo.md']` → `productFiles.length === 0`), the mixed case (`['specs/foo.md', 'packages/x/y.ts']` → `productFiles = ['packages/x/y.ts']`), and the empty-diff case (`[]` → `productFiles.length === 0`).
  Depends on T004.

## Phase 3: Wire the check into the phase loop

- [ ] T006 [US1][US2] Modify `packages/orchestrator/src/worker/phase-loop.ts`:
  1. Import `EXCLUDED_PATH_PREFIXES`, `computeProductDiff`, `resolveBaseRef` from `./product-diff.js`.
  2. Replace the block currently at lines 344–396 (the `if (PHASES_REQUIRING_CHANGES.has(phase) && !hasChanges)` guard plus the entire `hasPriorImplementation` fallback with its commit-message heuristics) with the shape shown in `plan.md` §Implementation step 4 and `contracts/product-diff.md` §Consumer Contract:
     - Guard shrinks to `if (PHASES_REQUIRING_CHANGES.has(phase))` — `hasChanges` shortcut is subsumed (FR-001, FR-004).
     - Wrap `resolveBaseRef` + `computeProductDiff` in a `try/catch`; on throw, log with `{ phase, err }`, route through the same `labelManager.onError(phase)` + stage-comment + `result.success = false` path (`Failure Modes & Mitigations` row 1 — do NOT fall back to "allow" on detection failure).
     - When `productFiles.length === 0`, log `error` with structured fields `{ phase, baseRef, changedFiles, excluded: EXCLUDED_PATH_PREFIXES }` (per `data-model.md` §Log Fields), call `labelManager.onError(phase)`, call `stageCommentManager.updateStageComment({ status: 'error', ... })` matching the existing `PHASES_REQUIRING_CHANGES` failure branch, set `result.error.message` to the FR-005 wording (`Phase "${phase}" produced no product-code changes — all changed files are under excluded prefixes [${EXCLUDED_PATH_PREFIXES.join(', ')}]. Implement must modify at least one non-excluded file.`), and `return { results, completed: false, lastPhase: phase, gateHit: false }`.
  3. Delete the `hasPriorImplementation` local (or helper) and all `complete ${phase} phase` / `feat: complete T` / `partial implement progress` commit-message string constants (FR-004).
  4. Leave the increment-boundary handling at `phase-loop.ts:248–296` untouched — it `continue`s before reaching this block, keeping intermediate spec-only progress legitimate (Clarification Q5 / `Failure Modes & Mitigations` row 4).
  5. Confirm the check remains gated on `PHASES_REQUIRING_CHANGES.has(phase)` so `specify`/`clarify`/`plan`/`tasks` are exempt (FR-006).
  Depends on T004. Do not merge until T007 lands.

## Phase 4: Integration tests

- [ ] T007 [US1] Add an integration test in `packages/orchestrator/src/worker/__tests__/` (co-located with existing phase-loop tests; name it `phase-loop.product-diff.test.ts` or extend the nearest existing phase-loop integration file) reproducing agency#376 conditions per SC-001:
  - Arrange: workspace/branch state where `implement` has committed only under `specs/**` (mock `GitHubClient.getFilesChangedBetween` to return `['specs/820/tasks.md', 'specs/820/plan.md']`, or fixture a git repo — pick whichever matches the existing phase-loop test style).
  - Act: drive the phase loop through `implement` completion.
  - Assert: `PhaseLoopResult.completed === false`, `lastPhase === 'implement'`, `results[results.length - 1].error.message` matches `/no product-code changes/`, and `labelManager.onError` was called with `'implement'`. Assert `validate` was NEVER invoked (this is the SC-001 guarantee).
  Depends on T006.

- [ ] T008 [P] [US1] Add the SC-002 regression counterpart in the same file: mock `getFilesChangedBetween` to return `['packages/orchestrator/src/foo.ts']` (or `['specs/x/plan.md', 'packages/x/y.ts']` — mixed case). Assert the loop passes through the guard, reaches `validate`, and `labelManager.onError` is NOT called for the implement phase. Depends on T006.

## Phase 5: Polish

- [ ] T009 [US2] Grep-audit: run `rg -n 'hasPriorImplementation|complete \\$\\{phase\\} phase|feat: complete T|partial implement progress' packages/orchestrator/src/worker/` and confirm zero hits (all commit-message heuristics removed per FR-004). If any reference remains — even in a comment or dead code path — remove it. Depends on T006.

- [ ] T010 [P] [US1] Manual smoke: run `pnpm --filter @generacy-ai/orchestrator test -- product-diff` and `pnpm --filter @generacy-ai/orchestrator typecheck` locally; both must pass. If the workspace also runs `pnpm --filter @generacy-ai/workflow-engine typecheck`, run that too (T001/T002 touch its `interface.ts` / `gh-cli.ts`). Depends on T005, T007, T008.

## Dependencies & Execution Order

**Sequential spine**:
- T001 → T002 (implementation follows interface)
- T001, T003 → T004 (helper module consumes both new surfaces)
- T004 → T005 (unit tests need the module)
- T004 → T006 (phase-loop imports from the module)
- T006 → T007, T008 (integration tests exercise the wired-in check)
- T006 → T009 (grep-audit confirms heuristic removal survived the edit)
- T005, T007, T008 → T010 (manual smoke covers all test surfaces)

**Parallelizable**:
- T003 can run in parallel with T001/T002 (different package, no shared file).
- T005 (unit tests) can be authored in parallel with T006 (phase-loop wiring) once T004 lands — they touch different files. Marked `[P]`.
- T008 can be authored in parallel with T007 (same file but independent test cases; if the harness uses `describe.concurrent` or file-per-test convention, split accordingly). Marked `[P]`.
- T010 (smoke) runs after all test-touching tasks.

**Do not parallelize**:
- T006 must land after T004 — the import target must exist.
- T007/T008 must land after T006 — the integration surface being tested is the wired-in check.

## Notes for the implementing agent

- Zero new dependencies. No glob library, no minimatch, no path-normalization package (per plan.md §Technical Context and Constitution Check).
- Zero new env vars. `EXCLUDED_PATH_PREFIXES` is a module-level `const`, not `WorkerConfig` (Clarification Q1, plan.md §Constitution Check).
- The check fires *once per implement phase completion*, after the last increment `continue`s past. Do not add it to `PHASES_REQUIRING_CHANGES` for other phases (FR-006).
- Fail-loud on detection error: if `git diff` throws (missing `origin/<base>`, no fetch), route to `onError` with a message naming the failing base ref. Do NOT fall back to "allow" — that reintroduces the false negative this issue closes (plan.md §Failure Modes & Mitigations row 1).

---

*Generated 2026-07-06 from plan.md + contracts/product-diff.md*
