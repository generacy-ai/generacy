# Tasks: Epic Processing Support

**Input**: Design documents from feature directory
**Prerequisites**: plan.md (required), spec.md (required)
**Status**: Ready

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Workflow-Driven Phase Registry

### T001 [DONE] Define `WORKFLOW_PHASE_SEQUENCES` map and `getPhaseSequence()` helper
**File**: `packages/orchestrator/src/worker/types.ts`
- Add `WORKFLOW_PHASE_SEQUENCES` record mapping workflow names to phase arrays
  - `speckit-feature`: full 6-phase sequence (same as `PHASE_SEQUENCE`)
  - `speckit-bugfix`: full 6-phase sequence (same as `PHASE_SEQUENCE`)
  - `speckit-epic`: `['specify', 'clarify', 'plan', 'tasks']` (4 phases, no implement/validate)
- Add `getPhaseSequence(workflowName: string): WorkflowPhase[]` that looks up the map with fallback to `PHASE_SEQUENCE`
- Keep `PHASE_SEQUENCE` as default/fallback for backward compatibility

### T002 [DONE] Refactor `PhaseLoop` to accept a phase sequence parameter
**File**: `packages/orchestrator/src/worker/phase-loop.ts`
- Add optional `phaseSequence?: WorkflowPhase[]` parameter to `executeLoop()`
- Replace all internal references to `PHASE_SEQUENCE` with `const sequence = phaseSequence ?? PHASE_SEQUENCE`
- Update `buildPhaseProgress()` to take the sequence as a parameter instead of using the global
- Update the loop iteration (`for` loop) to use the local sequence
- Update the final `lastPhase` return to use the local sequence

### T003 [DONE] [P] Refactor `PhaseResolver` to be workflow-aware
**File**: `packages/orchestrator/src/worker/phase-resolver.ts`
- Add `workflowName?: string` parameter to `resolveStartPhase()`
- Add `WORKFLOW_GATE_MAPPING` keyed by workflow name for epic-specific gate behavior:
  - `speckit-epic.tasks-review` → `{ phase: 'tasks', resumeFrom: 'tasks' }` (resume triggers post-tasks, not implement)
  - `speckit-epic.children-complete` → dedicated handling (routes to epic-complete)
  - `speckit-epic.epic-approval` → dedicated handling (routes to epic-close)
- Update `resolveFromProcess()` to use `getPhaseSequence(workflowName)` instead of global `PHASE_SEQUENCE`
- Update `resolveFromContinue()` to check `WORKFLOW_GATE_MAPPING[workflowName]` first, falling back to global `GATE_MAPPING`

### T004 [DONE] [P] Add `speckit-epic` gate configuration defaults
**File**: `packages/orchestrator/src/worker/config.ts`
- Add `speckit-epic` entry to the `gates` default:
  - `{ phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'always' }`
  - `{ phase: 'tasks', gateLabel: 'waiting-for:tasks-review', condition: 'always' }`

### T005 [DONE] Update `ClaudeCliWorker` to pass workflow-specific phase sequence
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- Import `getPhaseSequence` from `./types.js`
- Before calling `phaseLoop.executeLoop()`, resolve the phase sequence: `const phaseSequence = getPhaseSequence(item.workflowName)`
- Pass `phaseSequence` as the new optional parameter to `executeLoop()`
- Pass `item.workflowName` to `phaseResolver.resolveStartPhase()` as the new optional parameter

### T006 [DONE] Write unit tests for workflow phase registry
**Files**:
- `packages/orchestrator/src/worker/__tests__/types.test.ts` (new)
- `packages/orchestrator/src/worker/__tests__/phase-loop.test.ts` (update)
- `packages/orchestrator/src/worker/__tests__/phase-resolver.test.ts` (update)
- Test `getPhaseSequence()` returns correct sequences for each workflow name
- Test `getPhaseSequence()` falls back to `PHASE_SEQUENCE` for unknown workflows
- Test `PhaseLoop` with epic sequence stops after tasks phase
- Test `PhaseLoop` with custom sequence only iterates specified phases
- Test `PhaseResolver` with `workflowName` resolves workflow-specific gates
- Test `PhaseResolver` falls back to global `GATE_MAPPING` for non-epic workflows
- Verify all existing tests still pass unchanged

---

## Phase 2: `speckit.tasks_to_issues` Workflow-Engine Action

### T007 [DONE] Define types for tasks-to-issues action
**File**: `packages/workflow-engine/src/types/github.ts` (or new file alongside speckit types)
- Add `TasksToIssuesInput` interface: `feature_dir`, `epic_issue_number`, `epic_branch`, `trigger_label?`
- Add `TasksToIssuesOutput` interface: `created_issues[]`, `skipped_issues[]`, `failed_tasks[]`, `total_tasks`
- Add `ParsedTask` interface: `title`, `type?`, `labels?`, `description`, `task_id`

### T008 [DONE] Implement task parser for structured `tasks.md`
**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/tasks-to-issues.ts` (new)
- Implement `parseTasksFile(content: string): ParsedTask[]`
- Support structured format: `## Task N` headings with YAML frontmatter between `---` delimiters
- Parse `title` (required), `type` (optional), `labels` (optional) from frontmatter
- Extract body text after second `---` until next heading as description
- Fallback: if no frontmatter, use heading text as title and section body as description
- Handle edge cases: empty file, no tasks, malformed frontmatter

### T009 [DONE] Implement issue creation with idempotency
**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/tasks-to-issues.ts`
- Implement `executeTasksToIssues(input: TasksToIssuesInput, context: ActionContext): Promise<TasksToIssuesOutput>`
- Read `tasks.md` from `input.feature_dir`
- Parse via `parseTasksFile()`
- For each parsed task:
  - Search for existing child: `gh issue list --search '"epic-parent: #N" "task: TXXX" in:body'`
  - If exists → add to `skipped_issues` (idempotent)
  - If not → create issue with:
    - Title from task
    - Body containing: `epic-parent: #N`, `task: {taskId}`, `epic-branch: {epicBranch}`, description
    - Labels: `['epic-child', triggerLabel ?? 'process:speckit-feature']` + task-specific labels
  - Track created/failed issues
- Return `TasksToIssuesOutput` summary

### T010 [DONE] [P] Register action in speckit namespace
**File**: `packages/workflow-engine/src/actions/builtin/speckit/index.ts`
- Add `'tasks_to_issues'` to the operation dispatch switch/map
- Import and wire `executeTasksToIssues`
- Add input validation for `TasksToIssuesInput` (require `feature_dir`, `epic_issue_number`, `epic_branch`)

### T011 [DONE] [P] Add epic-related label definitions
**File**: `packages/workflow-engine/src/actions/github/label-definitions.ts`
- Add missing epic labels to `WORKFLOW_LABELS` array (check which already exist):
  - `waiting-for:children-complete` (yellow #FBCA04) — "Epic waiting for all children to complete"
  - `completed:children-complete` (green #0E8A16) — "All epic children completed"
  - `waiting-for:epic-approval` (yellow #FBCA04) — "Epic rollup PR awaiting approval"
  - `completed:epic-approval` (green #0E8A16) — "Epic rollup PR approved and merged"
  - `process:speckit-epic` (purple trigger label) — if not already present
  - `workflow:speckit-epic` (workflow identity label) — if not already present
- Verify `type:epic` and `epic-child` labels already exist (they do per codebase analysis)

### T012 [DONE] Write unit tests for tasks-to-issues action
**Files**:
- `packages/workflow-engine/src/actions/builtin/speckit/operations/__tests__/tasks-to-issues.test.ts` (new)
- Test `parseTasksFile()`: structured format with frontmatter
- Test `parseTasksFile()`: fallback format without frontmatter
- Test `parseTasksFile()`: empty file returns empty array
- Test `parseTasksFile()`: malformed frontmatter gracefully handled
- Test `executeTasksToIssues()`: creates issues with correct labels and body
- Test `executeTasksToIssues()`: idempotent — skips existing children
- Test `executeTasksToIssues()`: partial failure — reports failed tasks
- Test `executeTasksToIssues()`: handles empty tasks.md

---

## Phase 3: Epic Post-Tasks Step in Worker

### T013 [DONE] Create `EpicPostTasks` handler
**File**: `packages/orchestrator/src/worker/epic-post-tasks.ts` (new)
- Implement `EpicPostTasks` class with `execute(context: WorkerContext)` method
- Steps:
  1. Import and invoke `executeTasksToIssues()` directly (no CLI)
  2. Call `epic.dispatch_children` with created issue numbers (add trigger labels)
  3. Call `epic.post_tasks_summary` to post summary comment on epic
  4. Add `waiting-for:children-complete` label to the epic
- Return `{ childIssues: number[], success: boolean }`
- Error handling: log failures, return partial results

### T014 [DONE] Integrate `EpicPostTasks` into `ClaudeCliWorker` for loop completion
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- After phase loop completes (`loopResult.completed`), check if `item.workflowName === 'speckit-epic'`
- If epic:
  - Run `EpicPostTasks.execute(context)`
  - Do NOT call `labelManager.onWorkflowComplete()` (epic is paused, not done)
  - Do NOT call `prManager.markReadyForReview()` (no PR yet for epic itself)
  - Return after post-tasks complete
- Non-epic workflows continue with existing completion logic unchanged

### T015 [DONE] Handle tasks-review gate resume for epics
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- When `item.workflowName === 'speckit-epic'` and `item.command === 'continue'`:
  - Check issue labels for `completed:tasks-review`
  - If present: run `EpicPostTasks.execute(context)` directly (children not yet created)
  - This bypasses the phase loop for this specific resume case
- Ensure the `PhaseResolver` workflow-aware gate mapping from T003 supports this routing

### T016 [DONE] Write unit tests for epic post-tasks
**Files**:
- `packages/orchestrator/src/worker/__tests__/epic-post-tasks.test.ts` (new)
- Test post-tasks orchestration: tasks-to-issues → dispatch → summary → label
- Test error handling: partial failure in child creation
- Test that `waiting-for:children-complete` label is added
- Test integration with `ClaudeCliWorker`: epic loop completion triggers post-tasks
- Test tasks-review gate resume triggers post-tasks correctly

---

## Phase 4: Epic Completion Monitor Service

### T017 [DONE] Create `EpicCompletionMonitorService`
**File**: `packages/orchestrator/src/services/epic-completion-monitor-service.ts` (new)
- Implement service with constructor: `logger`, `createClient` (GitHubClientFactory), `queueAdapter`, `config`, `repositories`
- Implement `startPolling()` and `stopPolling()` lifecycle methods (same pattern as `LabelMonitorService`)
- Use `AbortController` for clean shutdown
- Default poll interval: 300000ms (5 minutes)

### T018 [DONE] Implement polling logic for epic child completion
**File**: `packages/orchestrator/src/services/epic-completion-monitor-service.ts`
- For each repository:
  1. Search for issues with label `waiting-for:children-complete`
  2. For each epic found:
     - Find children via GitHub search: `"epic-parent: #N" in:body`
     - Check completion: count children with closed state and merged PRs
     - Calculate percentage complete
  3. Update `<!-- epic-status -->` comment with progress table (markdown)
  4. If all children complete (100%):
     - Remove `waiting-for:children-complete` label
     - Add `completed:children-complete` label
     - (LabelMonitorService will detect this and enqueue `epic-complete`)

### T019 [DONE] [P] Extract shared child-finding utility
**File**: `packages/workflow-engine/src/actions/epic/find-children.ts` (new or extract from existing)
- Implement `findChildIssues(owner, repo, epicNumber): Promise<EpicChild[]>`
- Uses `gh issue list --search '"epic-parent: #N" in:body'` pattern
- Returns structured child info: `number`, `title`, `state`, `labels`, `hasMergedPr`
- Shared between `EpicCompletionMonitorService` and `epic.check_completion` action

### T020 [DONE] [P] Add epic monitor configuration schema
**File**: `packages/orchestrator/src/config/schema.ts`
- Add `EpicMonitorConfigSchema`:
  - `enabled: z.boolean().default(true)`
  - `pollIntervalMs: z.number().int().min(60000).default(300000)` (5 min)
- Add `epicMonitor: EpicMonitorConfigSchema.default({})` to `OrchestratorConfigSchema`

### T021 Write unit tests for epic completion monitor
**Files**:
- `packages/orchestrator/src/services/__tests__/epic-completion-monitor-service.test.ts` (new)
- Test polling loop starts/stops cleanly
- Test child detection via GitHub search
- Test progress comment updates with `<!-- epic-status -->` marker
- Test completion detection: adds `completed:children-complete` when all children done
- Test partial completion: updates progress but doesn't complete
- Test empty children list: handles gracefully
- Test error handling: individual repo failure doesn't crash service

---

## Phase 5: Epic Completion Handler

### T022 Extend `QueueItem` command type
**File**: `packages/orchestrator/src/types/monitor.ts`
- Add `'epic-complete'` to `QueueItem.command` union type:
  `command: 'process' | 'continue' | 'address-pr-feedback' | 'epic-complete'`

### T023 Create `EpicCompletionHandler`
**File**: `packages/orchestrator/src/worker/epic-completion-handler.ts` (new)
- Implement `EpicCompletionHandler` class (mirrors `PrFeedbackHandler` pattern)
- `handle(item: QueueItem, checkoutPath: string): Promise<void>`
- Two flows based on which `completed:*` label triggered it:
  - **`completed:children-complete`**: Verify all children complete → checkout epic branch → call `epic.create_pr` (rollup PR to develop) → add `waiting-for:epic-approval` label → remove `completed:children-complete`
  - **`completed:epic-approval`**: Call `epic.close` (close epic issue with completion comment) → remove `completed:epic-approval` → mark workflow complete

### T024 Route `epic-complete` command in `ClaudeCliWorker`
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- Add `epic-complete` command routing alongside `address-pr-feedback`:
  ```
  if (item.command === 'epic-complete') {
    route to EpicCompletionHandler
  }
  ```
- Ensure repo checkout happens (clone default branch, then switch to epic branch)
- Emit appropriate SSE events

### T025 Wire `LabelMonitorService` to detect epic completion labels
**File**: `packages/orchestrator/src/services/label-monitor-service.ts`
- In `processLabelEvent()`: when `event.type === 'resume'` and `parsedName` is `'children-complete'` or `'epic-approval'`:
  - Set `command` to `'epic-complete'` instead of `'continue'`
- This routes epic-specific resume events to the `EpicCompletionHandler` instead of the standard phase loop

### T026 Write unit tests for epic completion handler
**Files**:
- `packages/orchestrator/src/worker/__tests__/epic-completion-handler.test.ts` (new)
- Test children-complete flow: creates rollup PR, adds `waiting-for:epic-approval`
- Test epic-approval flow: closes epic issue
- Test error handling: children not actually complete (verification)
- Test label management: removes completed labels, adds waiting labels
- Test command routing in `ClaudeCliWorker`

---

## Phase 6: Epic Branch Strategy

### T027 Detect epic-child branch override in `ClaudeCliWorker`
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- After fetching issue data, check issue body for `epic-branch: {branchName}` marker
- If found: use epic branch as the base for checkout instead of default branch
  - `checkoutPath = await this.repoCheckout.ensureCheckout(workerId, owner, repo, epicBranch)`
- Pass epic branch info into `WorkerContext` (add optional `baseBranch?: string` to `WorkerContext`)

### T028 Add `baseBranch` parameter to `PrManager`
**File**: `packages/orchestrator/src/worker/pr-manager.ts`
- Add optional `baseBranch?: string` constructor parameter
- In `ensureDraftPr()`: use `this.baseBranch ?? await this.github.getDefaultBranch()` as the PR base
- This ensures child PRs target the epic branch instead of develop/main

### T029 [P] Add `baseBranch` to `WorkerContext`
**File**: `packages/orchestrator/src/worker/types.ts`
- Add optional `baseBranch?: string` field to `WorkerContext` interface
- Document: "Base branch for PRs — set when processing epic child issues"

### T030 Wire base branch through worker initialization
**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`
- When creating `PrManager`, pass `context.baseBranch` if available
- When building `WorkerContext`, set `baseBranch` from epic-branch detection (T027)
- Ensure feature branch resolution still works: for epic children resuming, find branch by issue number prefix

### T031 Write unit tests for epic branch strategy
**Files**:
- `packages/orchestrator/src/worker/__tests__/claude-cli-worker.test.ts` (update)
- `packages/orchestrator/src/worker/__tests__/pr-manager.test.ts` (new or update)
- Test epic-child detection from issue body `epic-branch:` marker
- Test `PrManager` creates PR targeting epic branch
- Test `PrManager` falls back to default branch when no `baseBranch`
- Test child issue branches from epic branch

---

## Phase 7: Server Integration

### T032 Initialize `EpicCompletionMonitorService` in server
**File**: `packages/orchestrator/src/server.ts`
- Import `EpicCompletionMonitorService`
- After label monitor setup, create instance if `config.epicMonitor.enabled` and repos configured
- Pass: `server.log`, `createGitHubClient`, `queueAdapter`, `config.epicMonitor`, `config.repositories`

### T033 Add lifecycle hooks for epic monitor
**File**: `packages/orchestrator/src/server.ts`
- In `onReady` hook: start `epicMonitorService.startPolling()` (background, non-blocking)
- In graceful shutdown cleanup array: call `epicMonitorService.stopPolling()`
- Guard both with `if (epicMonitorService)` null checks

### T034 [P] Update worker exports
**File**: `packages/orchestrator/src/worker/index.ts`
- Export `EpicPostTasks` from `./epic-post-tasks.js`
- Export `EpicCompletionHandler` from `./epic-completion-handler.js`

### T035 [P] Update service exports
**File**: `packages/orchestrator/src/services/index.ts`
- Export `EpicCompletionMonitorService` from `./epic-completion-monitor-service.js`

### T036 Write integration test for server initialization
**Files**:
- `packages/orchestrator/src/__tests__/server.test.ts` (update if exists)
- Test epic monitor starts on server ready when enabled
- Test epic monitor does not start when `epicMonitor.enabled = false`
- Test graceful shutdown stops epic monitor

---

## Phase 8: End-to-End Testing and Validation

### T037 Write integration test: epic specify→tasks flow
**Files**:
- `packages/orchestrator/src/__tests__/epic-workflow.integration.test.ts` (new)
- Test epic phases execute in correct sequence: specify → clarify → plan → tasks
- Test epic does NOT execute implement or validate phases
- Test gate at clarify phase pauses workflow
- Test gate at tasks phase pauses workflow

### T038 Write integration test: tasks → child issues
**Files**:
- `packages/orchestrator/src/__tests__/epic-workflow.integration.test.ts`
- Test structured tasks.md parsed into child issues
- Test children created with `epic-parent: #N` body marker
- Test children get `epic-child` + `process:speckit-feature` labels
- Test idempotent retry: re-running creates missing children, skips existing

### T039 Write integration test: child completion → epic-complete
**Files**:
- `packages/orchestrator/src/__tests__/epic-workflow.integration.test.ts`
- Test monitor detects all children complete
- Test `completed:children-complete` label added to epic
- Test `LabelMonitorService` enqueues `epic-complete` command
- Test `EpicCompletionHandler` creates rollup PR

### T040 Write integration test: epic-approval → close
**Files**:
- `packages/orchestrator/src/__tests__/epic-workflow.integration.test.ts`
- Test `completed:epic-approval` triggers `epic-complete` command
- Test `EpicCompletionHandler` closes the epic issue
- Test epic marked as complete

### T041 Write integration test: epic branch hierarchy
**Files**:
- `packages/orchestrator/src/__tests__/epic-workflow.integration.test.ts`
- Test epic branch created from default branch during specify phase
- Test children branch from epic branch (detect `epic-branch:` in body)
- Test child PRs target epic branch
- Test rollup PR merges epic branch into develop

### T042 Validate all existing tests pass
**Files**: All test files
- Run full test suite: `pnpm test` across orchestrator and workflow-engine packages
- Verify no regressions in existing `speckit-feature` and `speckit-bugfix` workflows
- Verify existing label monitor tests pass
- Verify existing worker tests pass

---

## Dependencies & Execution Order

**Phase dependencies (sequential)**:
- Phase 1 must complete before Phase 3 (post-tasks depends on workflow-aware phase loop)
- Phase 2 must complete before Phase 3 (post-tasks calls tasks-to-issues action)
- Phase 3 must complete before Phase 5 (completion handler depends on post-tasks flow)
- Phase 4 must complete before Phase 7 (server integration wires up the monitor)
- Phase 5 must complete before Phase 7 (server routes epic-complete commands)
- Phase 6 can start after Phase 1 (needs workflow context, not post-tasks)
- Phase 8 depends on all other phases

**Parallel opportunities within phases**:
- **Phase 1**: T003 and T004 can run in parallel (different files, no deps)
- **Phase 2**: T010 and T011 can run in parallel (different packages)
- **Phase 4**: T019 and T020 can run in parallel (different packages)
- **Phase 6**: T029 can run in parallel with T027/T028
- **Phase 7**: T034 and T035 can run in parallel (different index files)
- **Phases 1 and 2 can run in parallel** (no code dependencies between them)
- **Phase 4 can start as soon as Phase 2 is done** (shares child-finding utility)
- **Phase 6 can start as soon as Phase 1 is done** (independent of Phases 2-5)

**Critical path**:
T001 → T002 → T005 → T013 → T014/T015 → T022 → T023 → T024/T025 → T032/T033 → T037-T042

**Parallel critical path (shortest)**:
```
Phase 1 (T001→T002→T005) ─┐
                           ├→ Phase 3 (T013→T014→T015) → Phase 5 (T022→T023→T024→T025) ─┐
Phase 2 (T007→T008→T009) ─┘                                                              │
                                                                                          ├→ Phase 7 → Phase 8
Phase 4 (T017→T018) ─────────────────────────────────────────────────────────────────────┘
Phase 6 (T027→T028→T030) ────────────────────────────────────────────────────────────────┘
```

---

*Generated from plan.md and spec.md — 42 tasks across 8 phases*
