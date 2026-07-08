# Tasks: no-checks is not RED — CI-less repos merge on `completed:validate`

**Input**: Design documents from `/specs/857-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: `[US1]` — the sole story ("CI-less repo can merge on `completed:validate`"; sub-story pins for regression coverage inline)

## Phase 1: Wrapper — absence ≠ failure

Foundation change. Every consumer downstream depends on the wrapper's post-fix return shape (`[]` instead of throw for the no-checks case), so this ships first.

- [X] T001 [US1] Modify `getPullRequestCheckRuns` in `packages/cockpit/src/gh/wrapper.ts` (method at lines 587–606). When `result.exitCode !== 0`, trim stderr once, then short-circuit `return []` when `stderr.toLowerCase().includes('no checks reported')`. Otherwise fall through to the existing #855 `logger.warn({ repo, prNumber, ghStderr }, 'gh pr checks failed')` + throw path unchanged. Preserve the exact error message format `` `gh pr checks failed (exit ${result.exitCode}): ${stderr}` ``. Source diff pinned in `plan.md` §`wrapper.ts` delta and `contracts/get-pull-request-check-runs.md`.

## Phase 2: Type widenings

Parallel type-carrier edits. Both files are independent one-line union changes; no runtime path yet. Downstream renderers pick up automatically via existing `String.padEnd` / `===` / `!==` call sites.

- [X] T002 [P] [US1] Widen `ChecksRollup` in `packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts` from `'pending' | 'success' | 'failure'` to `'pending' | 'success' | 'failure' | 'none' | 'error'`. Contract: `contracts/checks-rollup-union.md` §Union declaration.
- [X] T003 [P] [US1] Widen `StatusRow.checks` in `packages/generacy/src/cli/commands/cockpit/status/row.ts` from `'pending' | 'success' | 'failure' | 'none'` to `'pending' | 'success' | 'failure' | 'none' | 'error'`. Widen the matching `checks` parameter type on `buildStatusRow(...)`. Body unchanged.

## Phase 3: Producers and consumers

Depends on Phase 1 (wrapper) and Phase 2 (union types). Files are all distinct → all parallel-eligible with each other, but each must land after its type dependency (T002 for anything importing `ChecksRollup`, T003 for `StatusRow.checks`).

- [X] T004 [P] [US1] Modify `rollup(checks: CheckRunSummary[])` in `packages/generacy/src/cli/commands/cockpit/watch/check-rollup.ts`: change the empty-input branch from `return 'pending'` to `return 'none'`. All non-empty branches unchanged. Depends on T002.
- [X] T005 [P] [US1] Modify the `getPullRequestCheckRuns` `try/catch` block in `packages/generacy/src/cli/commands/cockpit/status.ts` (lines ~125-127). Widen the local `checks` variable type to include `'error'`; change the `catch` branch from `checks = 'none'` to `checks = 'error'`. The `try` branch (`checks = rollup(checkRuns)`) is unchanged — it now naturally produces `'none'` for empty results via T004. Depends on T003 + T004.
- [X] T006 [P] [US1] Modify the `getPullRequestCheckRuns` `try/catch` block in `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts` (lines ~99-101). Replace the `checks: CheckRunSummary[]` local with a `checksResult: ChecksRollup` local; call `rollup(...)` inside the `try` branch; set `checksResult = 'error'` in the `catch` branch; pass `checksResult` directly into `buildPrSnapshot(...)` (was `rollup(checks)`). Depends on T002 + T004.
- [X] T007 [US1] Extend `runMerge` decision tree in `packages/generacy/src/cli/commands/cockpit/merge.ts` (block at lines 137–169). After the `getRequiredCheckNames` + `getPullRequestCheckRuns` parallel fetch and the existing `fallback-pr-checks` warn log, insert a new branch BEFORE `classifyChecks(...)`: compute `noActual = actualChecks.length === 0` and `noRequired = required.source === 'branch-protection' ? (required.names?.length ?? 0) === 0 : true`. When `noActual && noRequired`, call `mergePullRequest(repo, pr.number, { squash: true })`, `logger.info({ pr: pr.number }, 'PR merged')`, and `return { exitCode: 0, stdout: 'no checks configured and none required — proceeding on completed:validate\n' }`. Byte-exact FR-003 note (em-dash U+2014, terminating `\n`, lowercase). All non-vacuous paths fall through unchanged. Source diff pinned in `plan.md` §`merge.ts` delta and `contracts/run-merge-decision.md`.

## Phase 4: Regression tests

All test files are distinct; parallel-eligible with each other. Depends on Phases 1–3 (behavior under test).

- [X] T008 [P] [US1] Modify `packages/cockpit/src/__tests__/gh-wrapper.test.ts` per `contracts/get-pull-request-check-runs.md` §Regression tests. Add three new `getPullRequestCheckRuns` cases: (i) stderr `no checks reported on the '002-phase-1-foundation-part' branch` + exit 1 → resolves `[]`, `logger.warn` NOT called (FR-002 corollary); (ii) stderr `No Checks Reported` (mixed case) + exit 1 → still resolves `[]` (case-insensitive detection); (iii) stderr `Some other error mentioning checks` + exit 1 → still throws + logs warn once (substring is fixed literal, not any-mention). Existing #855 drift / positive-list tests untouched.
- [X] T009 [P] [US1] Modify `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts` per FR-011 and `contracts/run-merge-decision.md` §Regression tests. Add three cases with `fakeGh` fixtures matching the wrapper's post-fix shape: (a) CI-less unprotected repo (`getRequiredCheckNames` returns `{ source: 'fallback-pr-checks', names: null }`, `getPullRequestCheckRuns` returns `[]`) + `completed:validate` label → `{ exitCode: 0, stdout: 'no checks configured and none required — proceeding on completed:validate\n' }`, `mergePullRequest` called with `{ squash: true }`; (b) `{ source: 'branch-protection', names: ['ci/test', 'ci/lint'] }` + empty actual → `exitCode === 1`, red payload's `failingChecks` names `['ci/test', 'ci/lint']` each with `state: 'MISSING'`, reason `'checks-failing'`; (c) non-empty actual with a `FAILURE` state → unchanged red path, exit 1. Fixture bodies in `data-model.md` §Test fixture shapes.
- [X] T010 [P] [US1] Modify `packages/generacy/src/cli/commands/cockpit/__tests__/watch.check-rollup.test.ts` per `contracts/checks-rollup-union.md` §Regression tests. Assert `rollup([]) === 'none'` (was `'pending'`); pin unchanged non-empty behavior: `rollup([{name:'a', state:'PENDING'}]) === 'pending'`, `rollup([{name:'a', state:'SUCCESS'}]) === 'success'`, `rollup([{name:'a', state:'FAILURE'}]) === 'failure'`.
- [X] T011 [P] [US1] Modify `packages/generacy/src/cli/commands/cockpit/__tests__/watch.actionable.test.ts` per Q3→A and `contracts/checks-rollup-union.md`. Add: PR snapshot with `checksRollup === 'none'` and no actionable labels → NOT actionable; PR snapshot with `checksRollup === 'error'` and no actionable labels → NOT actionable. Pin unchanged: `checksRollup === 'failure'` → actionable.
- [X] T012 [P] [US1] Modify `packages/generacy/src/cli/commands/cockpit/__tests__/watch.diff.test.ts` per Q3→A and `contracts/checks-rollup-union.md`. Add: prev `pending` → curr `none` emits one `pr-checks` event; prev `none` → curr `success` emits one `pr-checks` event; prev `success` → curr `error` emits one `pr-checks` event.
- [X] T013 [P] [US1] Modify (or create) `packages/generacy/src/cli/commands/cockpit/__tests__/status.test.ts` per `contracts/checks-rollup-union.md` §Regression tests. Assert real wrapper throw → row's `checks === 'error'`; wrapper resolves `[]` → row's `checks === 'none'`; `'error'` and `'none'` render as distinct strings in the row (not conflated).

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 (wrapper) → T005, T006, T007 (consumers use the new `[]`-instead-of-throw contract).
- T002 (union widen) → T004 (`rollup` returns `'none'`), T005 (`status.ts` local type), T006 (`checksResult` local type).
- T003 (`StatusRow.checks` widen) → T005 (`status.ts` writes into `StatusRow`).
- T004 (`rollup([]) === 'none'`) → T005, T006 (consumers rely on the new empty semantics).
- Phase 3 → Phase 4 (tests exercise post-fix behavior).

**Parallel opportunities**:
- **Phase 2**: T002, T003 (two separate files, no dependency).
- **Phase 3**: T004, T005, T006, T007 — all in distinct files, run concurrently once their type dependencies (T002, T003) land.
- **Phase 4**: T008–T013 — six distinct test files, fully parallel.

**Suggested execution**:
1. T001.
2. T002 || T003 (parallel).
3. T004 || T005 || T006 || T007 (parallel).
4. T008 || T009 || T010 || T011 || T012 || T013 (parallel).

**Total**: 13 tasks. Wrapper: 1. Types: 2. Producers/consumers: 4. Tests: 6.

---

*Generated by speckit — mode: standard (fine-grained)*
