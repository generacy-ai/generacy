# Tasks: tasks.md safety net misses the heading task grammar

**Input**: Design documents from `/specs/1192-summary-1187-tasks-md/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/tasks-md-grammar.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Grammar Fix

- [ ] T001 [US1] Add the two heading-grammar regexes as module-level constants in `packages/orchestrator/src/worker/tasks-md-fallback.ts`, alongside the existing `CHECKBOX_LINE`:
  `const HEADING_TASK = /^#{1,6}[ \t]+T\d+(?![-–—]\s*T?\d)\b/;` (FR-001, Q3=A boundary rejects `### T001-T026 remaining` + en-/em-dash variants) and
  `const HEADING_DONE = /^#{1,6}[ \t]+T\d+[ \t]+\[DONE\]/;` (FR-002, Q2=B strict — `[DONE]` immediately after the task-ID token, case-sensitive).

- [ ] T002 [US1] Extend the per-line loop in `countTasks` (`tasks-md-fallback.ts`) to add heading detection, keeping the checkbox branch byte-identical (FR-004): test `CHECKBOX_LINE` first and `continue` on match (existing behavior); otherwise test `HEADING_TASK`; on a heading-task match, `HEADING_DONE.test(line)` → `checked++`, else `unchecked++`. Both grammars increment the same `unchecked`/`checked` counters so mixed files sum (FR-003). Update the `countTasks` docstring to describe both grammars. Do NOT touch `evaluateTasksMd`, its discriminated union, or the FS/`unreadable` paths (FR-007, US3).

## Phase 2: FR-006 Operator Signal

- [ ] T003 [US2] Add one log-only branch in the phase-loop `complete` handling in `packages/orchestrator/src/worker/phase-loop.ts` (the safety-net block ~`:906-913`). After the existing `unreadable` branch, add `else if (evalResult.kind === 'complete' && evalResult.total === 0)` emitting a distinct `info` line (e.g. "tasks.md safety net: advancing — no task lines recognized in either grammar"), keyed on `total === 0`. `complete` with `total > 0` (all-checked) stays silent, exactly as today. The evaluator stays pure/loggerless and `TasksMdEvaluation` is unchanged (Q1=A). This is the only phase-loop change; the #1187 increment wiring is otherwise untouched.

## Phase 3: Tests

- [ ] T004 [P] [US1] Extend `packages/orchestrator/src/worker/__tests__/tasks-md-fallback.test.ts` with the heading-grammar `countTasks` matrix (SC-002, per contracts/tasks-md-grammar.md truth table): `### T001 Description` → unchecked; `### T001 [DONE] Description` → checked; `## T001 [DONE]` (any level 1–6) → checked; `### T001 Description [DONE]` and `### T005 Verify [DONE] rendering` → unchecked (Q2=B strict); `### T001-T026 remaining` + en-dash `–` + em-dash `—` variants → 0 tasks (Q3=A boundary); `### Phase 3.1: T012`, `### Task T001`, `### Notes on T001` → 0 tasks (not anchored); mixed checkbox + heading file → summed (FR-003).

- [ ] T005 [P] [US1] Add an `evaluateTasksMd` unit test in `tasks-md-fallback.test.ts`: a `### T001`-only fixture (no `[DONE]`) classifies as `kind: 'incomplete'` (SC-001), and a `### T001 [DONE]`-only fixture classifies as `complete`.

- [ ] T006 [P] [US3] Confirm the existing checkbox `countTasks`/`evaluateTasksMd` matrix in `tasks-md-fallback.test.ts` still passes unchanged (SC-003) and that `unreadable` classification (missing/ambiguous spec dir, unreadable `tasks.md`) is unaffected (FR-007). Add a fail-open assertion that a resolved zero-task-line-of-either-grammar `tasks.md` returns `complete` (SC-004, FR-005).

- [ ] T007 [US2] Add/extend a phase-loop test in `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` asserting the FR-006 distinct log signal fires on the `complete` + `total === 0` branch and does NOT fire for a `complete` + `total > 0` (all-checked) file. Keep the existing sentinel-present and no-sentinel re-entry assertions green (SC-005).

## Phase 4: Changeset

- [ ] T008 [P] Add `.changeset/1192-tasks-md-heading-grammar.md` — a **newly added** changeset marking `@generacy-ai/orchestrator` **patch** (`workflow:speckit-bugfix`; internal `worker/` behavior fix, no new public exports, no new label vocabulary). Required per the CLAUDE.md changeset gate because non-test `packages/orchestrator/src/` files change (T002, T003).

## Dependencies & Execution Order

- **T001 → T002**: the regexes must exist before the counting branch uses them (same file).
- **T002 → T004, T005, T006**: the grammar tests exercise the new counting behavior.
- **T003 → T007**: the phase-loop log test exercises the new FR-006 branch.
- **T003 depends on nothing in Phase 1** structurally (different file), but the FR-006 signal is only meaningful once heading counting exists; land T001–T002 first for a coherent change.
- **T008** (changeset) can be written any time but only *satisfies the gate* once the src changes (T002, T003) are in the diff.

**Parallel opportunities**:
- T004, T005, T006 are all in `tasks-md-fallback.test.ts` — they are `[P]` in intent (independent test cases) but share one file, so apply as sequential edits to that file if edited by one agent.
- T008 is fully independent (`[P]`).
- T007 (`phase-loop.test.ts`) is independent of the `tasks-md-fallback.test.ts` tasks.

**Sequential phase boundaries**: Phase 1 (grammar) before Phase 3 grammar tests; Phase 2 (log line) before its Phase 3 test (T007). Phase 4 changeset closes out.
