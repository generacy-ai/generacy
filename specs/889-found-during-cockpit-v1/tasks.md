# Tasks: `waiting-for:merge-conflicts` provisioning + label-op crash-loop fix

**Input**: Design documents from `/specs/889-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), data-model.md, research.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = pre-existing-repo pause, US2 = fail-item-not-worker, US3 = drift audit)

## Phase 1: Foundation (new types + trivial label add)

- [X] T001 [P] [US2] Create `TerminalLabelOpError` class in `packages/orchestrator/src/worker/terminal-label-op-error.ts` — exports the class with `site` / `labelOp` / `ghStderr` / `cause` fields per `contracts/terminal-label-op-error.md`, plus `isTerminalLabelOpError(e): e is TerminalLabelOpError` guard. Six-value `TerminalLabelOpSite` union: `'gate-hit' | 'phase-start' | 'phase-complete' | 'error' | 'resume-start' | 'workflow-complete'`.
- [X] T002 [P] [US2] Create `WorkerResult` discriminated union in `packages/orchestrator/src/worker/worker-result.ts` — `{ status: 'completed' } | { status: 'failed-terminal'; failureMetadata: { site; labelOp; ghStderr } }` per `contracts/worker-result.md`. No `'released'` variant (release is default on unhandled throw).
- [X] T003 [P] [US1] [US3] **FR-001** — Append `{ name: 'waiting-for:merge-conflicts', color: 'FBCA04', description: 'Waiting for base-merge conflict resolution' }` to `WORKFLOW_LABELS` in `packages/workflow-engine/src/actions/github/label-definitions.ts`. Placement: after the `waiting-for:dependencies` entry, preserving the `waiting-for:*` grouping.

## Phase 2: LabelManager — memoized ensure-pass + terminal error propagation

- [X] T004 [US2] Widen `WorkerHandler` type in `packages/orchestrator/src/types/monitor.ts` from `Promise<void>` to `Promise<WorkerResult>`. Import `WorkerResult` from `../worker/worker-result.js`. Depends on T002.
- [X] T005 [US1] **FR-002** — Add memoized ensure-pass to `LabelManager` in `packages/orchestrator/src/worker/label-manager.ts`:
  - Class-level `private static ensuredRepos = new Set<string>()` (key `"owner/repo"`).
  - Class-level `private static ensureInFlight = new Map<string, Promise<void>>()` for concurrent-first-caller dedupe.
  - New private method `ensureRepoLabelsExist(): Promise<void>` — early-return if already ensured; otherwise share in-flight Promise if one exists; otherwise call `github.listLabels()`, compute missing set against `WORKFLOW_LABELS`, and `github.createLabel()` per miss. Per-label create failures logged at `warn` and swallowed (create-race with sibling workers on the same repo is expected and safe).
- [X] T006 [US2] **FR-003** — Modify `LabelManager.retryWithBackoff` signature in `label-manager.ts` to accept `context: { site: TerminalLabelOpSite; labelOp: string }`. On final-attempt failure, wrap the underlying `Error` in a new `TerminalLabelOpError({ site, labelOp, ghStderr: extractStderr(err), cause: err })` and throw. `extractStderr()`: returns `err.message` if `err instanceof Error`, else `String(err)`. Depends on T001.
- [X] T007 [US1] [US2] Update all six `LabelManager` retry sites (`onGateHit`, `onPhaseStart`, `onPhaseComplete`, `onError`, `onResumeStart`, `onWorkflowComplete`) in `label-manager.ts` to (a) `await ensureRepoLabelsExist()` as the first statement inside the retry callback, and (b) pass `{ site, labelOp }` context into `retryWithBackoff`. `labelOp` is a human-readable descriptor like `"addLabels([waiting-for:merge-conflicts, agent:paused])"`. `ensureCleanup` is NOT updated (already best-effort swallow). Depends on T005, T006.

## Phase 3: Phase loop + worker wiring + failure alert

- [X] T008 [US2] Extend `PhaseLoopResult` in `packages/orchestrator/src/worker/types.ts` (or wherever the type lives — verify) with `status: PhaseLoopStatus` (`'completed' | 'gate-hit' | 'phase-failed' | 'failed-terminal'`) and optional `failureMetadata: { site; labelOp; ghStderr }`. Backwards-compatible with existing readers of `completed` / `gateHit` / `lastPhase`.
- [X] T009 [US2] Modify `packages/orchestrator/src/worker/phase-loop.ts` — every site awaiting `deps.labelManager.on*` (including `pausePreMergeConflict`) wraps in `try/catch`; on `isTerminalLabelOpError(e)`, return a `PhaseLoopResult` with `status: 'failed-terminal'` and `failureMetadata` copied from the error. Non-label throws still propagate. Depends on T001, T008.
- [X] T010 [US2] Modify `packages/orchestrator/src/worker/claude-cli-worker.ts` — `processItem` catches `TerminalLabelOpError` and returns `{ status: 'failed-terminal', failureMetadata }`; also returns that shape when `loopResult.status === 'failed-terminal'`. All happy-path exits return `{ status: 'completed' }`. Non-label errors continue to re-throw (unchanged release behavior). Depends on T002, T004, T009.
- [X] T011 [US2] **FR-004** — Extend `FailureAlertData.stage` union with `'label-op'` in `packages/orchestrator/src/worker/types.ts` (verify current location). Update `renderFailureAlert` in `packages/orchestrator/src/worker/stage-comment-manager.ts` with a summary line for `stage: 'label-op'`: `` ❌ **label operation failed** — `<labelOp>` at site `<site>` (exited 1). ``. Reuse existing `<details><summary>stderr…` block with `evidence.stderrTail = ghStderr`. See `contracts/failure-alert-label-op.md`.
- [X] T012 [US2] Modify `WorkerDispatcher.runWorker` in `packages/orchestrator/src/services/worker-dispatcher.ts`:
  - Await `this.handler(item)` and branch on `WorkerResult.status`:
    - `'completed'` → `queue.complete(...)` (unchanged).
    - `'failed-terminal'` → invoke new `terminalFailureHandler` callback (best-effort — try/catch each step), then `queue.complete(...)`. NEVER release.
  - Outer `catch` (unhandled throw) → `queue.release(...)` (unchanged).
  - Add `terminalFailureHandler?: (item, failureMetadata) => Promise<void>` optional constructor field (callback pattern for testability, per data-model.md recommendation).
  - Wire the handler at construction site (`server.ts`) to perform: (a) best-effort `agent:error` label via fresh `LabelManager` — `warn` on failure; (b) `stageCommentManager.postFailureAlert()` with `stage: 'label-op'`, fresh `runId`, `evidence` from `failureMetadata` — `error`-level log on failure; (c) no re-throw, no release. Depends on T002, T004, T011.

## Phase 4: Regression tests

- [X] T013 [P] [US1] **FR-005** — Create `packages/orchestrator/src/worker/__tests__/label-manager.ensure.test.ts`. Cases: (a) `ensureRepoLabelsExist` runs once per `(owner, repo)` across concurrent callers (asserts `listLabels` called exactly once, shared in-flight Promise); (b) missing labels from `WORKFLOW_LABELS` are created; (c) per-label create failure (`already exists`) is swallowed and does not abort the pass; (d) subsequent calls return early with no network activity. Depends on T005.
- [X] T014 [P] [US2] **FR-006** — Create `packages/orchestrator/src/worker/__tests__/label-manager.terminal.test.ts`. Cases: retry exhaustion at each of the six sites (`onGateHit`, `onPhaseStart`, `onPhaseComplete`, `onError`, `onResumeStart`, `onWorkflowComplete`) throws `TerminalLabelOpError` with correct `site`, `labelOp`, `ghStderr`, and `cause`. Depends on T006, T007.
- [X] T015 [P] [US1] **FR-005** — Extend `packages/orchestrator/src/worker/__tests__/phase-loop.merge.test.ts` (or the existing merge-conflict test file — verify name) with a fixture where `github.listLabels` returns a set *without* `waiting-for:merge-conflicts`. Assert sequence: `listLabels` → `createLabel('waiting-for:merge-conflicts', …)` → `addLabels([waiting-for:merge-conflicts, agent:paused])` — all within one `onGateHit` call. Assert pause succeeds. Depends on T005, T007.
- [X] T016 [P] [US2] **FR-006** — Create `packages/orchestrator/src/services/__tests__/worker-dispatcher.terminal.test.ts`. Mocks a handler returning `{ status: 'failed-terminal', failureMetadata: { site: 'gate-hit', labelOp: 'addLabels([waiting-for:merge-conflicts, agent:paused])', ghStderr: "label 'waiting-for:merge-conflicts' not found" } }`. Asserts: (a) `queue.complete` called; (b) `queue.release` NOT called; (c) `terminalFailureHandler` invoked; (d) `stageCommentManager.postFailureAlert` called with `stage: 'label-op'` and `evidence` derived from `failureMetadata`; (e) `agent:error` label add attempted best-effort; (f) worker proceeds to next item after failure (no unhandled throw). Depends on T012.
- [X] T017 [P] [US3] **FR-007** — Create `packages/orchestrator/src/__tests__/label-protocol-audit.test.ts`:
  - **Load-bearing static scan**: recursively `readdir` `packages/orchestrator/src/` and `packages/workflow-engine/src/`, filter `*.ts` excluding `**/__tests__/**` + `**/*.test.ts`, `readFile` each, regex-match `/(['"`])(phase|completed|waiting-for|failed|agent):[a-z0-9-]+\1/g`. Union all matches, subtract `WORKFLOW_LABELS.map(l => l.name)`; assert the difference is empty. Curated `AUDIT_EXCLUSIONS: Set<string>` (empty today) handles legitimate false positives.
  - **Secondary runtime-registry probe**: instantiate `LabelManager` with a mock `GitHubClient` capturing every `addLabels` call. Drive representative flows: `onGateHit(<each phase>, 'waiting-for:merge-conflicts')`, `onPhaseStart(<each phase>)`, `onPhaseComplete(<each phase>)`, `onError(<each phase>)`, `onResumeStart()`, `onWorkflowComplete()`. Assert every captured label symbol is in `WORKFLOW_LABELS` AND `ensureRepoLabelsExist` was called exactly once across the sequence (proves FR-002 memoization). Depends on T003, T005.

## Phase 5: Verification

- [X] T018 **FR-008 (non-regression)** — Run full test suites: `pnpm --filter @generacy-ai/orchestrator test` and `pnpm --filter @generacy-ai/workflow-engine test`. All pre-existing label-manager and phase-loop tests must pass unchanged. Depends on T001–T017.

## Dependencies & Execution Order

**Phase 1 (parallel-safe)** — T001, T002, T003 all touch distinct files with no code cross-refs. Run all three in parallel.

**Phase 2 (mostly sequential in one file)** — T005, T006, T007 all edit `label-manager.ts`. Order: T005 → T006 → T007. T004 depends on T002 and is a small edit to `monitor.ts` — can run in parallel with T005/T006/T007.

**Phase 3 (sequential — shared types, cascading deps)** —
- T008 → T009 (phase-loop consumes the extended `PhaseLoopResult`).
- T009, T010 both need T008.
- T010 depends on T004 (widened `WorkerHandler`) and T009 (phase-loop returning `failed-terminal`).
- T011 is independent within Phase 3 (edits `stage-comment-manager.ts` + types) — can run in parallel with T008/T009/T010.
- T012 depends on T002 (`WorkerResult`), T004 (`WorkerHandler`), and T011 (`stage: 'label-op'` support).

**Phase 4 (fully parallel)** — T013–T017 each write a new test file with no cross-refs. All can run in parallel after Phase 3 completes.

**Phase 5** — T018 last; depends on everything.

**Parallel opportunities**:
- Phase 1: T001, T002, T003 in parallel.
- Phase 2: T004 in parallel with the T005→T006→T007 chain.
- Phase 3: T011 in parallel with T008→T009→T010 chain; T012 after both merge.
- Phase 4: all five test tasks (T013–T017) in parallel.

**Critical path**: T002 → T004 → T009 → T010 → T012 → T016 → T018.
