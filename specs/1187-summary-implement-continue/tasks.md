# Tasks: Engine-side tasks.md safety net for the implement→continue increment

**Input**: Design documents from `/specs/1187-summary-implement-continue/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/tasks-md-fallback-evaluator.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Setup

- [X] T001 [P] Add changeset `.changeset/1187-tasks-md-safety-net.md` — `@generacy-ai/orchestrator` **patch** (`workflow:speckit-bugfix`; internal `worker/` behavior fix, no new public exports, no new label vocabulary). Non-test `packages/orchestrator/src/` change requires it per the CLAUDE.md changeset gate.

## Phase 2: Core Implementation

- [X] T002 [US1] Create `packages/orchestrator/src/worker/tasks-md-fallback.ts` with the `TasksMdEvaluation` discriminated union (`incomplete` | `complete` | `unreadable`) and the pure `countTasks(content)` checkbox parser. Parser: split on newlines, test each line against `^[ \t]*[-*+] \[( |x|X)\]`; single-space capture ⇒ unchecked, `x`/`X` ⇒ checked; `total = unchecked + checked`; non-matching lines ignored (FR-007, contract §`countTasks`).
- [X] T003 [US1] In `tasks-md-fallback.ts`, implement the FS-backed `evaluateTasksMd(context: WorkerContext): TasksMdEvaluation`. Resolve `specs/{issueNumber}-*` under `context.checkoutPath` via `readdirSync` + prefix-match (convention from `epic-post-tasks.ts:293`). Classify per contract §`evaluateTasksMd`: specs dir missing/unreadable, zero matches, multiple ambiguous matches, and missing/unreadable `tasks.md` → `unreadable` (with reason); `unchecked > 0` → `incomplete`; `unchecked === 0` (all-checked OR zero task lines) → `complete` (FR-001, FR-004, FR-006, Q4=A).

## Phase 3: Integration

- [X] T004 [US1] Add the optional injection field `evaluateTasksMd?: (context: WorkerContext) => TasksMdEvaluation` to the `PhaseLoopDeps` interface in `packages/orchestrator/src/worker/phase-loop.ts` (mirrors the existing `remediateTrigger` / `phaseTracker` / `reviewExecutor` optional-DI pattern).
- [X] T005 [US1] Insert the synthesis block in `phase-loop.ts` immediately **before** the increment block at `:873`, gated on `phase === 'implement' && result.success && result.implementResult === undefined`. Call `(deps.evaluateTasksMd ?? evaluateTasksMd)(context)`; on `incomplete` set `result.implementResult = { partial: true, tasks_remaining: unchecked, tasks_completed: checked, tasks_total: total }`; on `unreadable` log the FR-006 reason at `info`; on `complete` no-op. Control then falls through to the unchanged `:873` block (no-progress guard, WIP commit/push, fresh session, `i--; continue`) (FR-002, FR-003, FR-005, contract §Phase-loop integration).
- [X] T006 [US2] Wire the default FS-backed `evaluateTasksMd` into `PhaseLoopDeps` at the construction site in `packages/orchestrator/src/worker/claude-cli-worker.ts` (on by default — no feature flag; the spec treats this as a correctness fix).

## Phase 4: Tests

- [X] T007 [P] [US1] Create `packages/orchestrator/src/worker/__tests__/tasks-md-fallback.test.ts`: `countTasks` grammar matrix (unchecked/checked/`X`/`*`/`+` bullets, leading whitespace, ignored `## heading`, `- [~]`, mid-prose bracket, empty string → all-zero) and `evaluateTasksMd` classification matrix — including the #26 fixture (T001–T011 checked / T012–T026 unchecked ⇒ `incomplete`) for SC-002, all-checked ⇒ `complete`, zero-task-lines ⇒ `complete`, missing/ambiguous dir and missing tasks.md ⇒ `unreadable`.
- [X] T008 [US1] Extend `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` with fallback cases via an injected `evaluateTasksMd` stub: no-sentinel + `incomplete` ⇒ re-enters implement (SC-001); no-progress across two increments ⇒ escalates with no-progress error (SC-004); `unreadable`/`complete` ⇒ advance and grant `completed:implement` (SC-003); and confirm the existing no-sentinel test (`checkoutPath: '/tmp/repo'`, no specs dir) still advances. Verify existing sentinel-driven increment tests remain unmodified (SC-005).

## Phase 5: Verification

- [X] T009 Run `pnpm --filter @generacy-ai/orchestrator test` (new + touched suites) and `pnpm --filter @generacy-ai/orchestrator build` / typecheck; confirm SC-001–SC-005 assertions pass and the sentinel fast path is byte-identical.

## Dependencies & Execution Order

- **T001** (changeset) is independent — `[P]`, can start immediately.
- **T002 → T003**: `evaluateTasksMd` (T003) depends on `countTasks` + the `TasksMdEvaluation` type (T002), same file, sequential.
- **T004 → T005**: the synthesis block (T005) uses the `PhaseLoopDeps` field (T004), same file, sequential.
- **T006** depends on T002/T003 (imports the default evaluator) and T004 (the field to wire into).
- **T007** `[P]` depends only on T002/T003 (the module under test).
- **T008** depends on T004/T005 (the phase-loop behavior under test).
- **T009** depends on all implementation + test tasks.

**Parallel opportunities**:
- T001 in parallel with all core work.
- T007 in parallel with T008 once their respective code deps (T002/T003 vs T004/T005) land — different test files.

**Suggested next step**: `/speckit:implement` to begin execution.
