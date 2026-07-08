# Tasks: Failure-alert bottom-of-thread comment (#865)

**Input**: Design documents from `/specs/865-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/failure-alert-comment.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = single user story for this bug fix)

## Phase 1: Types & Constants (`types.ts`)

- [ ] T001 [US1] Add `FAILURE_ALERT_MARKER_PREFIX` exported constant (`'<!-- generacy:failure-alert:'`) to `packages/orchestrator/src/worker/types.ts`, with JSDoc referencing the full marker shape and the contract file (`specs/865-found-during-cockpit-v1/contracts/failure-alert-comment.md`).
- [ ] T002 [US1] Add `FailureAlertData` exported interface to `packages/orchestrator/src/worker/types.ts` with fields `stage: StageType`, `runId: string`, `phase: WorkflowPhase`, `evidence: NonNullable<StageCommentData['errorEvidence']>` — plain object, no Zod validation. JSDoc per data-model.md §"New types".

## Phase 2: Stage Comment Manager (`stage-comment-manager.ts`)

- [ ] T003 [US1] Add `postFailureAlert(data: FailureAlertData): Promise<void>` public async method to `StageCommentManager` in `packages/orchestrator/src/worker/stage-comment-manager.ts`. Implementation per plan.md §"postFailureAlert on StageCommentManager": compose marker, call `this.github.getIssueComments(...)`, scan for `body.includes(marker)`, log info + return on dedup hit; otherwise render body via `renderFailureAlert(marker, data)`, call `this.github.addIssueComment(...)`, log info with `commentId`.
- [ ] T004 [US1] Add `renderFailureAlert(marker: string, data: FailureAlertData): string` private method to `StageCommentManager`. Output must be byte-exact match to contract §"Alert body layout" — marker line, blank line, summary line (`❌ **<phase> failed** — \`<command>\` <exitDescriptor>.`), blank, `<details><summary>stderr (last <N> lines)</summary>`, blank, fenced ` ```text ` block with backtick-neutralized stderr (` ``` ` → `` `​`` ``), blank, `</details>`. Reuse `#847`'s ZWSP substitution pattern from `appendEvidenceBlock`.

## Phase 3: Phase Loop Integration (`phase-loop.ts`)

- [ ] T005 [US1] Mint `runId` at the top of `PhaseLoop.executeLoop` in `packages/orchestrator/src/worker/phase-loop.ts` via `const runId = crypto.randomUUID();`. Add `runId` to the existing "Starting phase loop" log line. Do NOT add to `WorkerContext` or `PhaseResult`.
- [ ] T006 [US1] Wire `postFailureAlert` at the pre-validate install failure site (~line 168): extract `evidence` into a `const` shared with the existing `updateStageComment({ status: 'error', ..., errorEvidence: evidence })` call; add `await stageCommentManager.postFailureAlert({ stage, runId, phase, evidence })` immediately after the `updateStageComment` call, before the `return`.
- [ ] T007 [US1] Wire `postFailureAlert` at the unexpected spawn error catch site (~line 217): same pattern as T006 — extract evidence, add adjacent `postFailureAlert` call.
- [ ] T008 [US1] Wire `postFailureAlert` at the post-phase failure site (~line 354): same pattern as T006 — extract evidence, add adjacent `postFailureAlert` call. This is the site that handles `maxImplementRetries` exhaustion; intermediate retries flow through the retry branch (`status: 'in_progress'`) and are silent by construction.
- [ ] T009 [US1] Wire `postFailureAlert` at the product-diff detection / empty product diff sites (~lines 394, 416): same pattern as T006 for each site — extract evidence, add adjacent `postFailureAlert` call.
- [ ] T010 [US1] FR-007 fix at the no-progress guard site (~line 278): reorder so `result.error = { message, stderr: \`no progress: tasks_remaining stayed at ${tasksRemaining} across two increments\`, phase }` is set BEFORE evidence derivation; add `const evidence = this.buildErrorEvidence(phase, result)`; extend the existing `updateStageComment({ status: 'error', ..., prUrl: context.prUrl })` call with `errorEvidence: evidence`; add `await stageCommentManager.postFailureAlert({ stage, runId, phase, evidence })` after the `updateStageComment`. Use `command: 'implement (no-progress guard)'` in the alert data.

## Phase 4: Tests (`stage-comment-manager.test.ts`)

- [ ] T011 [P] [US1] Add test in `packages/orchestrator/src/worker/__tests__/stage-comment-manager.test.ts`: "postFailureAlert posts new comment with correct body bytes on first-time occurrence" — mock `getIssueComments` returning empty array, assert `addIssueComment` called once with body matching contract §"Alert body layout" byte-exactly (numeric exit descriptor `exit 1`).
- [ ] T012 [P] [US1] Add test: "postFailureAlert dedup — matching marker in existing comments → NO addIssueComment call, info log with `existingCommentId`" — mock `getIssueComments` returning `[{ id: 42, body: <matching marker> }]`, assert `addIssueComment` NOT called, assert logger.info called with `'Failure alert already exists — suppressing duplicate post'`.
- [ ] T013 [P] [US1] Add test: "postFailureAlert with timeout exitDescriptor" — `evidence.exitDescriptor = 'killed (SIGTERM) after 300000ms'`, assert summary line contains descriptor verbatim.
- [ ] T014 [P] [US1] Add test: "postFailureAlert with abort exitDescriptor + empty stderr" — `evidence.exitDescriptor = 'aborted'`, `evidence.stderrTail = '(stderr empty)'`, assert `<details>` block contains `(stderr empty)` inside the fenced text block.
- [ ] T015 [P] [US1] Add test: "postFailureAlert backtick-poisoned stderr neutralization" — `evidence.stderrTail` contains ` ``` `, assert output substitution keeps outer fenced block closed (ZWSP inserted between first two backticks).
- [ ] T016 [P] [US1] Add test: "postFailureAlert truncated stderr renders unchanged" — `evidence.stderrTail` starts with `… truncated (kept last 30 lines / 4096 bytes) …\n`, assert renders inside `<details>` unchanged.
- [ ] T017 [P] [US1] Add test: "marker shape regex" — assert body's first line matches `/^<!-- generacy:failure-alert:(specification|planning|implementation):[0-9a-f-]{36} -->$/`.
- [ ] T018 [P] [US1] Add test: "postFailureAlert does not alter canonical stage comment" — render stage comment before/after `postFailureAlert` and assert byte-identity (FR-008 invariant).

## Phase 5: Tests (`phase-loop.test.ts`)

- [ ] T019 [P] [US1] Add test in `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts`: "`runId` minting — two invocations produce distinct UUIDs" — run `executeLoop` twice on separate `PhaseLoop` instances (or same with reset), capture the `runId` used in `postFailureAlert` calls, assert both are UUID v4 shape and distinct.
- [ ] T020 [P] [US1] Add test: "`runId` stability within one invocation" — construct a scenario where two error sites hypothetically fire in the same `executeLoop` (or assert via mock spy that the same `runId` is captured across both sites), assert same `runId` used.
- [ ] T021 [P] [US1] Add test: "terminal-failure alert on pre-validate failure" — mock `runPreValidateInstall` returning `success: false`, assert `postFailureAlert` called once with `stage`, `phase`, `evidence.command = config.preValidateCommand`.
- [ ] T022 [P] [US1] Add test: "terminal-failure alert on post-phase failure (validate)" — mock `spawnPhase` returning failure for validate, assert `postFailureAlert` called once with `phase='validate'`, `evidence.command = config.validateCommand`.
- [ ] T023 [P] [US1] Add test: "NO alert on intermediate implement retry — successful retry" — mock `spawnPhase` failing for implement with `implementRetryCount < maxImplementRetries`, retry succeeds; assert `postFailureAlert` NOT called anywhere in the invocation.
- [ ] T024 [P] [US1] Add test: "terminal alert on implement retry exhaustion" — mock `spawnPhase` failing for implement with `implementRetryCount = maxImplementRetries`, assert `postFailureAlert` called exactly once.
- [ ] T025 [P] [US1] Add test: "no-progress site emits evidence and alerts" — mock implement partial with `tasksRemaining` unchanged; assert `updateStageComment({ status: 'error', ... })` called with non-empty `errorEvidence` AND `postFailureAlert` called with the same `evidence` object (referential identity or deep-equal). Assert `evidence.stderrTail` contains `no progress: tasks_remaining stayed at`.
- [ ] T026 [P] [US1] Add test: "multi-error-site dedup within one invocation" — construct two-error-site pass through one invocation, assert same `runId` on both sites and dedup path (second `getIssueComments` sees first comment).

## Phase 6: Manual Verification (Quickstart)

- [ ] T027 [US1] Run quickstart §"Verify the fix (post-#865)" repro against a test cluster: trigger a validate failure on a scaffold with no `test` script, confirm new bottom-of-thread comment appears with the expected summary line, confirm a GitHub notification arrives with the diagnosis in the preview.
- [ ] T028 [US1] Run quickstart §"Verify no duplicate alerts on repeated polls" and §"Verify no alerts on intermediate retries" — count marker-carrying comments via `gh api`, confirm exactly one after terminal failure and zero after successful intermediate retry.

## Dependencies & Execution Order

**Sequential dependencies**:
- **Phase 1 (T001, T002)** must complete first — `FailureAlertData` and `FAILURE_ALERT_MARKER_PREFIX` are imported by Phase 2 and 3.
- **Phase 2 (T003, T004)** must complete before Phase 3 — `phase-loop.ts` calls `stageCommentManager.postFailureAlert(...)`. T004 (`renderFailureAlert`) is called by T003 (`postFailureAlert`), so T004 blocks T003.
- **Phase 3 (T005–T010)** must complete before Phase 5 tests (T019–T026) — the tests assert `postFailureAlert` calls from the phase-loop wire-up.
- **T005 (`runId` minting)** must precede T006–T010 (each site uses the local `runId`).
- **Phases 4 and 5 (tests)** run after their respective product-code phases, but within each test phase all tasks are `[P]` (different `describe` blocks in the same file — vitest handles them independently).
- **Phase 6 (T027, T028)** runs last, after everything is merged.

**Parallel opportunities**:
- T001 and T002 can be one edit to `types.ts` — sequential in the same file but no cross-blocking.
- T006, T007, T008, T009 are edits to different regions of `phase-loop.ts` — must be applied sequentially due to shared file, but can be planned together.
- T011–T018 (all `stage-comment-manager.test.ts` additions) are independent test cases in the same file — write them together in one edit pass.
- T019–T026 (all `phase-loop.test.ts` additions) are independent test cases in the same file — write them together in one edit pass.

**Total tasks**: 28 (10 product-code + 16 test + 2 manual verification)

## Suggested Next Step

Run `/speckit:implement` to begin execution.
