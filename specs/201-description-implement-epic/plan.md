# Implementation Plan: Epic Processing Support

## Summary

This plan adds **epic processing support** to the orchestrator — enabling issues with `type:epic` label to flow through specify/clarify/plan/tasks phases, then deterministically create child issues from `tasks.md`, dispatch them, and monitor their completion. The architecture introduces a workflow-driven phase registry (replacing the global `PHASE_SEQUENCE`), a new `speckit.tasks_to_issues` workflow-engine action, a separate `EpicCompletionMonitorService`, and an `epic-complete` command handler in the worker.

### Core Architecture

```
Epic Issue (type:epic + process:speckit-epic)
        │
        ▼
LabelMonitorService detects process:speckit-epic
        │
        ▼
RedisQueueAdapter.enqueue({ command: 'process', workflowName: 'speckit-epic' })
        │
        ▼
WorkerDispatcher → ClaudeCliWorker.handle()
        │
        ▼
PhaseLoop (epic sequence: specify → clarify → plan → tasks)
        │  Uses WORKFLOW_PHASE_SEQUENCES['speckit-epic']
        │
        ▼
Post-tasks: Direct workflow-engine actions (no CLI)
        ├── speckit.tasks_to_issues  → parse tasks.md → create child GitHub issues
        ├── epic.dispatch_children   → add process:speckit-feature to children
        ├── epic.post_tasks_summary  → post summary comment on epic
        └── Add waiting-for:children-complete label
        │
        ▼
EpicCompletionMonitorService (5-min poll interval)
        │  Searches for issues with waiting-for:children-complete
        │  Calls epic.check_completion via GitHub search
        │  Updates <!-- epic-status --> comment on epic
        │
        ▼ (all children complete → completed:children-complete label)
        │
LabelMonitorService detects completed:children-complete
        │
        ▼
RedisQueueAdapter.enqueue({ command: 'epic-complete' })
        │
        ▼
ClaudeCliWorker → EpicCompletionHandler
        ├── epic.create_pr  → rollup PR from epic branch to develop
        └── Add waiting-for:epic-approval label
        │
        ▼ (human merges PR, adds completed:epic-approval)
        │
LabelMonitorService detects completed:epic-approval
        │
        ▼
RedisQueueAdapter.enqueue({ command: 'epic-complete' })
        │
        ▼
EpicCompletionHandler → epic.close → close epic issue
```

## Technical Context

| Aspect | Detail |
|--------|--------|
| Language | TypeScript (ES modules) |
| Server | Fastify |
| Queue | Redis sorted sets via `RedisQueueAdapter` |
| GitHub API | `gh` CLI via `GhCliGitHubClient` from `@generacy-ai/workflow-engine` |
| Deduplication | `PhaseTrackerService` (Redis `SET NX`) |
| Config | Zod schemas in `packages/orchestrator/src/worker/config.ts` |
| Testing | Vitest |
| Epic state tracking | GitHub search (`epic-parent: #N in:body`) — no Redis |

### Key Files (Existing)

| File | Role |
|------|------|
| `packages/orchestrator/src/worker/types.ts` | `PHASE_SEQUENCE`, `WorkflowPhase`, `PHASE_TO_COMMAND`, `PHASE_TO_STAGE` |
| `packages/orchestrator/src/worker/phase-loop.ts` | `PhaseLoop.executeLoop()` — iterates phases |
| `packages/orchestrator/src/worker/phase-resolver.ts` | `PhaseResolver`, `GATE_MAPPING` |
| `packages/orchestrator/src/worker/claude-cli-worker.ts` | Worker entry point — routes commands |
| `packages/orchestrator/src/worker/config.ts` | `WorkerConfigSchema`, `GateDefinitionSchema` |
| `packages/orchestrator/src/worker/gate-checker.ts` | `GateChecker` — checks gates per workflow |
| `packages/orchestrator/src/worker/label-manager.ts` | Label lifecycle management |
| `packages/orchestrator/src/worker/stage-comment-manager.ts` | Stage comment updates |
| `packages/orchestrator/src/worker/pr-feedback-handler.ts` | Reference: specialized command handler pattern |
| `packages/orchestrator/src/services/label-monitor-service.ts` | Label polling + webhook detection |
| `packages/orchestrator/src/services/worker-dispatcher.ts` | Queue polling, concurrency, heartbeats |
| `packages/orchestrator/src/types/monitor.ts` | `QueueItem`, `QueueAdapter`, `PhaseTracker` |
| `packages/orchestrator/src/server.ts` | Service initialization and lifecycle |
| `packages/workflow-engine/src/actions/epic/` | Existing epic actions (6 handlers) |
| `packages/workflow-engine/src/actions/builtin/speckit/` | Existing speckit operations |
| `packages/workflow-engine/src/actions/github/label-definitions.ts` | `WORKFLOW_LABELS` |

### Key Files (New)

| File | Role |
|------|------|
| `packages/orchestrator/src/worker/epic-completion-handler.ts` | Worker handler for `epic-complete` command |
| `packages/orchestrator/src/worker/epic-post-tasks.ts` | Post-tasks step: create children + dispatch |
| `packages/orchestrator/src/services/epic-completion-monitor-service.ts` | Polls for epic child completion |
| `packages/workflow-engine/src/actions/builtin/speckit/operations/tasks-to-issues.ts` | Parse tasks.md → create child issues |

---

## Implementation Phases

### Phase 1: Workflow-Driven Phase Registry

**Goal**: Replace the global `PHASE_SEQUENCE` with a per-workflow phase sequence map so epic and future workflows can define their own phase lists.

#### 1.1 Define `WORKFLOW_PHASE_SEQUENCES` map

**File**: `packages/orchestrator/src/worker/types.ts`

Add a workflow-keyed phase sequence registry alongside the existing constants:

```typescript
/**
 * Phase sequences by workflow name.
 * Each workflow can define its own ordered list of phases.
 */
export const WORKFLOW_PHASE_SEQUENCES: Record<string, WorkflowPhase[]> = {
  'speckit-feature': ['specify', 'clarify', 'plan', 'tasks', 'implement', 'validate'],
  'speckit-bugfix': ['specify', 'clarify', 'plan', 'tasks', 'implement', 'validate'],
  'speckit-epic': ['specify', 'clarify', 'plan', 'tasks'],
};

/**
 * Look up phase sequence for a workflow, falling back to the default.
 */
export function getPhaseSequence(workflowName: string): WorkflowPhase[] {
  return WORKFLOW_PHASE_SEQUENCES[workflowName] ?? PHASE_SEQUENCE;
}
```

Keep `PHASE_SEQUENCE` as the default/fallback — existing code continues to work unchanged until migrated.

#### 1.2 Refactor `PhaseLoop` to accept a phase sequence parameter

**File**: `packages/orchestrator/src/worker/phase-loop.ts`

Change `executeLoop()` to accept an optional `phaseSequence` parameter:

```typescript
async executeLoop(
  context: WorkerContext,
  config: WorkerConfig,
  deps: PhaseLoopDeps,
  phaseSequence?: WorkflowPhase[],  // NEW — defaults to PHASE_SEQUENCE
): Promise<PhaseLoopResult> {
  const sequence = phaseSequence ?? PHASE_SEQUENCE;
  // Replace all references to PHASE_SEQUENCE with `sequence` within this method
  ...
}
```

Update `buildPhaseProgress()` to also take the sequence as a parameter.

#### 1.3 Update `ClaudeCliWorker` to pass workflow-specific sequence

**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`

```typescript
import { getPhaseSequence } from './types.js';

// In handle():
const phaseSequence = getPhaseSequence(item.workflowName);
const loopResult = await phaseLoop.executeLoop(context, this.config, deps, phaseSequence);
```

#### 1.4 Refactor `PhaseResolver` to be workflow-aware

**File**: `packages/orchestrator/src/worker/phase-resolver.ts`

Add `workflowName` parameter to `resolveStartPhase()`:

```typescript
resolveStartPhase(
  labels: string[],
  command: 'process' | 'continue' | 'epic-complete',
  workflowName?: string,
): WorkflowPhase {
  const sequence = workflowName ? getPhaseSequence(workflowName) : PHASE_SEQUENCE;
  // Use `sequence` instead of PHASE_SEQUENCE in resolution logic
  ...
}
```

#### 1.5 Create workflow-aware gate mapping

**File**: `packages/orchestrator/src/worker/phase-resolver.ts`

Add an optional workflow-specific gate mapping:

```typescript
export const WORKFLOW_GATE_MAPPING: Record<string, Record<string, { phase: WorkflowPhase; resumeFrom: WorkflowPhase }>> = {
  'speckit-epic': {
    'tasks-review': { phase: 'tasks', resumeFrom: 'tasks' }, // Resume triggers child creation
    'children-complete': { phase: 'tasks', resumeFrom: 'tasks' }, // Triggers epic-complete
    'epic-approval': { phase: 'tasks', resumeFrom: 'tasks' }, // Triggers epic.close
  },
};
```

The `resolveFromContinue()` method checks `WORKFLOW_GATE_MAPPING[workflowName]` first, falling back to the global `GATE_MAPPING`.

#### 1.6 Update `WorkerConfig` gates with epic defaults

**File**: `packages/orchestrator/src/worker/config.ts`

Add `speckit-epic` gate configuration to the defaults:

```typescript
gates: z.record(z.string(), z.array(GateDefinitionSchema)).default({
  'speckit-feature': [
    { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'always' },
  ],
  'speckit-bugfix': [],
  'speckit-epic': [
    { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'always' },
    { phase: 'tasks', gateLabel: 'waiting-for:tasks-review', condition: 'always' },
  ],
}),
```

**Acceptance Criteria**:
- TypeScript compiles without errors
- Existing `speckit-feature` and `speckit-bugfix` workflows work identically
- `getPhaseSequence('speckit-epic')` returns `['specify', 'clarify', 'plan', 'tasks']`
- `PhaseLoop` with epic sequence stops after tasks phase
- All existing tests pass with no modifications

---

### Phase 2: `speckit.tasks_to_issues` Workflow-Engine Action

**Goal**: Implement a deterministic action that parses structured `tasks.md` and creates child GitHub issues.

#### 2.1 Define types

**File**: `packages/workflow-engine/src/types/github.ts`

Add input/output types for the new action:

```typescript
export interface TasksToIssuesInput {
  /** Path to the feature directory containing tasks.md */
  feature_dir: string;
  /** Epic issue number (parent) */
  epic_issue_number: number;
  /** Epic branch name (children branch from here) */
  epic_branch: string;
  /** Trigger label for child issues (default: process:speckit-feature) */
  trigger_label?: string;
}

export interface TasksToIssuesOutput {
  /** Successfully created child issue numbers */
  created_issues: number[];
  /** Tasks that already had existing child issues (idempotent skip) */
  skipped_issues: number[];
  /** Tasks that failed to create */
  failed_tasks: Array<{ task_title: string; reason: string }>;
  /** Total tasks parsed from tasks.md */
  total_tasks: number;
}

export interface ParsedTask {
  /** Task title from frontmatter */
  title: string;
  /** Task type (feature, bugfix, refactor) */
  type?: string;
  /** Additional labels */
  labels?: string[];
  /** Task description (markdown body) */
  description: string;
  /** Original task ID from tasks.md (e.g., T001) */
  task_id: string;
}
```

#### 2.2 Implement task parser

**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/tasks-to-issues.ts`

```typescript
/**
 * Parse structured tasks.md with YAML frontmatter per task section.
 *
 * Expected format:
 * ## Task 1
 * ---
 * title: Implement user authentication
 * type: feature
 * labels: [auth, security]
 * ---
 * Description of the task...
 */
export function parseTasksFile(content: string): ParsedTask[]
```

Parser rules:
- Each task starts with `## Task N` or `### TXXX` heading
- YAML frontmatter between `---` delimiters provides metadata
- Body text after second `---` until next heading is the description
- `title` is required; `type` and `labels` are optional
- Fallback: if no frontmatter, use heading text as title and section body as description

#### 2.3 Implement issue creation with idempotency

**File**: `packages/workflow-engine/src/actions/builtin/speckit/operations/tasks-to-issues.ts`

```typescript
export async function executeTasksToIssues(
  input: TasksToIssuesInput,
  context: ActionContext
): Promise<TasksToIssuesOutput>
```

Flow:
1. Read `tasks.md` from `input.feature_dir`
2. Parse into `ParsedTask[]` via `parseTasksFile()`
3. For each task:
   a. Search for existing child: `gh issue list --search '"epic-parent: #N" "task: TXXX" in:body'`
   b. If exists → add to `skipped_issues`, continue (idempotent)
   c. Create issue with:
      - Title: task title
      - Body: `epic-parent: #${epicNumber}\ntask: ${taskId}\nepic-branch: ${epicBranch}\n\n${description}`
      - Labels: `['epic-child', input.trigger_label ?? 'process:speckit-feature']` + task-specific labels
   d. Track created issue numbers
4. Return `TasksToIssuesOutput`

#### 2.4 Register action in speckit namespace

**File**: `packages/workflow-engine/src/actions/builtin/speckit/index.ts`

Add `tasks_to_issues` to the operation dispatch:

```typescript
case 'speckit.tasks_to_issues':
  return executeTasksToIssues(step.with as TasksToIssuesInput, context);
```

#### 2.5 Add label definitions

**File**: `packages/workflow-engine/src/actions/github/label-definitions.ts`

Add epic-related labels if not already present:

```typescript
{ name: 'waiting-for:children-complete', color: 'FBCA04', description: 'Epic waiting for all children to complete' },
{ name: 'completed:children-complete', color: '0E8A16', description: 'All epic children completed' },
{ name: 'waiting-for:epic-approval', color: 'FBCA04', description: 'Epic rollup PR awaiting approval' },
{ name: 'completed:epic-approval', color: '0E8A16', description: 'Epic rollup PR approved and merged' },
{ name: 'type:epic', color: '6F42C1', description: 'Epic issue containing child tasks' },
```

**Acceptance Criteria**:
- Parses structured tasks.md with YAML frontmatter
- Falls back gracefully when frontmatter is missing
- Creates child issues with `epic-parent: #N` body marker
- Idempotent on retry (skips already-created children)
- Unit tests cover: parsing, idempotent retry, partial failure, empty tasks.md

---

### Phase 3: Epic Post-Tasks Step in Worker

**Goal**: After the tasks phase completes for an epic, execute child creation and dispatch as direct workflow-engine actions (no CLI).

#### 3.1 Create `EpicPostTasks` handler

**File**: `packages/orchestrator/src/worker/epic-post-tasks.ts` (NEW)

```typescript
import { createGitHubClient } from '@generacy-ai/workflow-engine';
import type { WorkerContext, Logger } from './types.js';

export class EpicPostTasks {
  constructor(private readonly logger: Logger) {}

  /**
   * Execute post-tasks steps for epic workflows:
   * 1. Parse tasks.md and create child issues
   * 2. Dispatch children (add trigger labels)
   * 3. Post tasks summary comment on epic
   * 4. Add waiting-for:children-complete label
   */
  async execute(context: WorkerContext): Promise<{
    childIssues: number[];
    success: boolean;
  }>
}
```

Implementation:
1. Call `speckit.tasks_to_issues` directly (import and invoke the operation function)
2. Call `epic.dispatch_children` with the created issue numbers
3. Call `epic.post_tasks_summary` to post summary on the epic
4. Add `waiting-for:children-complete` label to the epic
5. Return child issue numbers for logging

#### 3.2 Integrate into `ClaudeCliWorker`

**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`

After the phase loop completes for an epic workflow, run the post-tasks step:

```typescript
// After phase loop completes (loopResult.completed === true)
if (loopResult.completed && item.workflowName === 'speckit-epic') {
  workerLogger.info('Epic phase loop complete — running post-tasks steps');
  const epicPostTasks = new EpicPostTasks(workerLogger);
  const postResult = await epicPostTasks.execute(context);

  if (postResult.success) {
    workerLogger.info(
      { childIssues: postResult.childIssues },
      'Epic post-tasks complete: children created and dispatched'
    );
  }
  // Don't call labelManager.onWorkflowComplete() — epic is paused, not done
  // Don't mark PR ready — no PR yet for the epic itself
  return;
}
```

When `loopResult.gateHit` is true (e.g., `waiting-for:tasks-review`), the worker exits as normal. On resume (`completed:tasks-review`), the phase resolver routes back to post-tasks execution via the workflow-specific gate mapping.

#### 3.3 Handle tasks-review gate resume for epics

When an epic has `completed:tasks-review`, the `WORKFLOW_GATE_MAPPING` for `speckit-epic` routes to a post-tasks handler instead of the `implement` phase. The `ClaudeCliWorker` needs to detect this case:

```typescript
// In handle(), after phase resolution:
if (item.workflowName === 'speckit-epic' && item.command === 'continue') {
  const completedLabels = labels.filter(l => l.startsWith('completed:'));
  if (completedLabels.includes('completed:tasks-review')) {
    // Run post-tasks directly (children were not created yet)
    const epicPostTasks = new EpicPostTasks(workerLogger);
    await epicPostTasks.execute(context);
    return;
  }
}
```

**Acceptance Criteria**:
- Epic workflow completes specify→clarify→plan→tasks then creates children
- Children get `epic-child` + `process:speckit-feature` labels
- Epic gets `waiting-for:children-complete` label
- Post-tasks summary comment posted on epic
- Tasks-review gate pauses before child creation
- Resume after tasks-review creates children correctly

---

### Phase 4: Epic Completion Monitor Service

**Goal**: A standalone polling service that checks for epics with `waiting-for:children-complete` and updates their status.

#### 4.1 Create `EpicCompletionMonitorService`

**File**: `packages/orchestrator/src/services/epic-completion-monitor-service.ts` (NEW)

```typescript
export interface EpicMonitorConfig {
  enabled: boolean;
  pollIntervalMs: number;  // default: 300000 (5 min)
}

export class EpicCompletionMonitorService {
  constructor(
    logger: Logger,
    createClient: GitHubClientFactory,
    queueAdapter: QueueAdapter,
    config: EpicMonitorConfig,
    repositories: RepositoryConfig[],
  )

  async startPolling(): Promise<void>
  stopPolling(): void
}
```

#### 4.2 Polling logic

```
For each watched repository (sequential):
  1. Search for issues with label "waiting-for:children-complete"
     via github.listIssuesWithLabel(owner, repo, 'waiting-for:children-complete')

  2. For each epic issue found:
     a. Find children via `gh issue list --search '"epic-parent: #N" in:body'`
     b. Check completion: count closed children with merged PRs
     c. Update <!-- epic-status --> comment with progress table
     d. If all children complete (100%):
        - Remove waiting-for:children-complete
        - Add completed:children-complete
        → LabelMonitorService will detect this and enqueue epic-complete
```

The completion check reuses the logic from `epic.check_completion` action. Rather than importing the action class directly (which requires a workdir context), extract the search logic into a shared utility:

```typescript
// Shared utility: packages/workflow-engine/src/actions/epic/find-children.ts
export async function findChildIssues(
  owner: string,
  repo: string,
  epicNumber: number,
): Promise<EpicChild[]>
```

#### 4.3 Status comment updates

Use the existing `epic.update_status` pattern with `<!-- epic-status -->` HTML marker:

```markdown
<!-- epic-status -->
## Epic Progress

| Child | Status | PR |
|-------|--------|----|
| #123 Implement auth | :white_check_mark: Merged | #145 |
| #124 Add API routes | :hourglass: In progress | #146 |
| #125 Write tests | :clock1: Pending | — |

**Progress**: ██████░░░░ 33% (1/3 complete)
**Last checked**: 2026-02-21 23:30 UTC
```

#### 4.4 Add configuration

**File**: `packages/orchestrator/src/config/schema.ts`

```typescript
export const EpicMonitorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  pollIntervalMs: z.number().int().min(60000).default(300000), // 5 min default
});
export type EpicMonitorConfig = z.infer<typeof EpicMonitorConfigSchema>;
```

Add to `OrchestratorConfigSchema`:
```typescript
epicMonitor: EpicMonitorConfigSchema.default({}),
```

**Acceptance Criteria**:
- Polls every 5 minutes for `waiting-for:children-complete` issues
- Correctly identifies children via GitHub search
- Updates `<!-- epic-status -->` comment with progress
- Adds `completed:children-complete` when all children are done
- Graceful startup/shutdown lifecycle
- No interference with `LabelMonitorService`

---

### Phase 5: Epic Completion Handler

**Goal**: Add `epic-complete` as a new command type with a dedicated handler that creates the rollup PR and closes the epic.

#### 5.1 Extend `QueueItem` command type

**File**: `packages/orchestrator/src/types/monitor.ts`

```typescript
export interface QueueItem {
  ...
  command: 'process' | 'continue' | 'address-pr-feedback' | 'epic-complete';
  ...
}
```

#### 5.2 Create `EpicCompletionHandler`

**File**: `packages/orchestrator/src/worker/epic-completion-handler.ts` (NEW)

```typescript
export class EpicCompletionHandler {
  constructor(
    private readonly logger: Logger,
  )

  async handle(item: QueueItem, checkoutPath: string): Promise<void>
}
```

Processing flow (mirrors `PrFeedbackHandler` pattern):

**When triggered by `completed:children-complete`:**
1. Get epic issue labels
2. Confirm all children are complete (call `epic.check_completion`)
3. Checkout epic branch
4. Call `epic.create_pr` → creates rollup PR to develop/main
5. Add `waiting-for:epic-approval` label to epic
6. Remove `completed:children-complete` label

**When triggered by `completed:epic-approval`:**
1. Call `epic.close` → close the epic issue with completion comment
2. Remove `completed:epic-approval` label
3. Mark workflow as complete

#### 5.3 Route in `ClaudeCliWorker`

**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`

Add `epic-complete` command routing alongside `address-pr-feedback`:

```typescript
if (item.command === 'epic-complete') {
  workerLogger.info('Routing to EpicCompletionHandler');
  const handler = new EpicCompletionHandler(workerLogger);
  const defaultBranch = await this.repoCheckout.getDefaultBranch(item.owner, item.repo);
  const checkoutPath = await this.repoCheckout.ensureCheckout(
    workerId, item.owner, item.repo, defaultBranch,
  );
  await handler.handle(item, checkoutPath);
  return;
}
```

#### 5.4 Wire `LabelMonitorService` to detect epic completion labels

The `LabelMonitorService` already detects `completed:*` labels and enqueues `continue` commands. For epic-specific completion labels, it needs to enqueue `epic-complete` instead:

```typescript
// In processLabelEvent():
if (event.type === 'resume') {
  const gateName = event.parsedName; // e.g., 'children-complete' or 'epic-approval'
  const isEpicCompletion = ['children-complete', 'epic-approval'].includes(gateName);

  const command = isEpicCompletion ? 'epic-complete' : 'continue';
  await this.queueAdapter.enqueue({
    ...item,
    command,
  });
}
```

**Acceptance Criteria**:
- `epic-complete` command routes to `EpicCompletionHandler`
- Creates rollup PR when all children are complete
- Closes epic when `completed:epic-approval` is detected
- Rollup PR includes `Closes #N` for the epic issue
- `needs:epic-approval` label added to rollup PR
- `waiting-for:epic-approval` label added to epic after PR creation

---

### Phase 6: Epic Branch Strategy

**Goal**: Ensure child issues branch from the epic branch and their PRs target the epic branch.

#### 6.1 Pass base branch to child workers

When child issues are created by `speckit.tasks_to_issues`, the issue body includes `epic-branch: {branchName}`. When the `ClaudeCliWorker` picks up a child issue:

**File**: `packages/orchestrator/src/worker/claude-cli-worker.ts`

```typescript
// In handle(), during repository checkout:
// Check if this is an epic child — parse epic-branch from issue body
const epicBranchMatch = issue.body?.match(/epic-branch:\s*(.+)/);
if (epicBranchMatch) {
  const epicBranch = epicBranchMatch[1].trim();
  // Clone and checkout the epic branch instead of default branch
  checkoutPath = await this.repoCheckout.ensureCheckout(
    workerId, item.owner, item.repo, epicBranch,
  );
}
```

#### 6.2 Pass base branch to `PrManager`

The `PrManager` currently creates PRs targeting the default branch. For epic children, the PR should target the epic branch:

**File**: `packages/orchestrator/src/worker/pr-manager.ts`

Add an optional `baseBranch` parameter:

```typescript
constructor(
  ...
  private readonly baseBranch?: string,  // NEW — defaults to repo default branch
)
```

When creating the draft PR, use `baseBranch` if provided:

```typescript
const base = this.baseBranch ?? await this.github.getDefaultBranch();
```

#### 6.3 Create epic branch during specify phase

When an epic first enters the specify phase, the `PrManager` needs to create the epic branch from the default branch. This happens naturally — the existing workflow creates a feature branch like `{issueNumber}-{short-name}` during the first commit/push in PrManager.

**Acceptance Criteria**:
- Epic branch created from default branch during first epic phase
- Child issues branch from the epic branch
- Child PRs target the epic branch
- Rollup PR merges epic branch into develop/main

---

### Phase 7: Server Integration

**Goal**: Wire up the `EpicCompletionMonitorService` in server initialization and lifecycle.

#### 7.1 Initialize service

**File**: `packages/orchestrator/src/server.ts`

```typescript
import { EpicCompletionMonitorService } from './services/epic-completion-monitor-service.js';

// After label monitor setup:
let epicMonitorService: EpicCompletionMonitorService | null = null;
if (config.epicMonitor.enabled && config.repositories.length > 0) {
  epicMonitorService = new EpicCompletionMonitorService(
    server.log,
    createGitHubClient,
    redisQueueAdapter ?? /* logging fallback */,
    config.epicMonitor,
    config.repositories,
  );
}
```

#### 7.2 Lifecycle hooks

```typescript
// onReady:
if (epicMonitorService) {
  epicMonitorService.startPolling().catch((error) => {
    server.log.error({ err: error }, 'Epic completion monitor polling failed');
  });
}

// Graceful shutdown:
if (epicMonitorService) {
  epicMonitorService.stopPolling();
}
```

**Acceptance Criteria**:
- Epic monitor starts on server ready
- Stops cleanly on shutdown
- Disabled when `epicMonitor.enabled = false`
- No impact on existing services

---

### Phase 8: Testing and Validation

**Goal**: Comprehensive tests for all new and modified components.

#### Unit Tests

| Test Suite | File | Covers |
|-----------|------|--------|
| Workflow Phase Registry | `worker/__tests__/types.test.ts` | `getPhaseSequence()`, fallback behavior |
| PhaseLoop (epic) | `worker/__tests__/phase-loop.test.ts` | Epic sequence stops after tasks, custom sequence support |
| PhaseResolver (workflow-aware) | `worker/__tests__/phase-resolver.test.ts` | Epic gate mapping, workflow-specific resolution |
| Task Parser | `workflow-engine/tests/actions/speckit/tasks-to-issues.test.ts` | Frontmatter parsing, fallback, edge cases |
| TasksToIssues Action | `workflow-engine/tests/actions/speckit/tasks-to-issues.test.ts` | Issue creation, idempotency, partial failure |
| EpicPostTasks | `worker/__tests__/epic-post-tasks.test.ts` | Post-tasks orchestration, error handling |
| EpicCompletionHandler | `worker/__tests__/epic-completion-handler.test.ts` | PR creation, epic close, label management |
| EpicCompletionMonitor | `services/__tests__/epic-completion-monitor-service.test.ts` | Polling, status updates, completion detection |

#### Integration Tests

| Test | Validates |
|------|-----------|
| Epic specify→tasks flow | Phases execute in epic sequence, stops after tasks |
| Tasks → child issues | Structured tasks.md parsed, children created with correct labels |
| Idempotent child creation | Retry creates missing children, skips existing ones |
| Child completion → epic-complete | Monitor detects, enqueues, handler creates PR |
| Epic-approval → close | Handler closes epic after rollup PR merge confirmation |
| Epic branch hierarchy | Children branch from epic branch, PRs target epic branch |

#### Acceptance Criteria Validation

| ID | Metric | Target | Test Method |
|----|--------|--------|-------------|
| AC-1 | Epics process through specify/plan/tasks | Pass | Integration test with mock CLI |
| AC-2 | Child issues created with correct labels | Pass | Unit test on TasksToIssues |
| AC-3 | Epic pauses with waiting-for:children-complete | Pass | Integration test |
| AC-4 | Completion tracking updates epic progress | Pass | Monitor service test |
| AC-5 | Epic auto-completes when all children done | Pass | End-to-end integration test |

---

## Key Technical Decisions

### 1. Workflow-driven phase registry (Q1: Option C)

**Decision**: `WORKFLOW_PHASE_SEQUENCES` map keyed by workflow name.

**Rationale**: The architecture already supports multiple workflow types (`speckit-feature`, `speckit-bugfix`). A per-workflow phase sequence map is the natural extension. The refactor is modest — `PhaseLoop.executeLoop()` takes an optional parameter and falls back to the global constant. This also benefits future workflows that may want different phase lists.

### 2. Direct workflow-engine action for child creation (Q2: Option B)

**Decision**: `speckit.tasks_to_issues` runs as a deterministic action, not via Claude CLI.

**Rationale**: Parsing `tasks.md` and creating GitHub issues is deterministic — it doesn't need AI. Using Claude CLI for this would waste tokens and add latency. The worker already has precedent for non-CLI execution (`runValidatePhase()` runs a shell command). The new action follows the existing `BaseAction` pattern in the workflow-engine.

### 3. Separate `EpicCompletionMonitorService` (Q3: Option B)

**Decision**: Standalone service with its own 5-minute polling interval.

**Rationale**: `LabelMonitorService` polls on 10-second intervals for label changes. Epic completion checks need a 5-minute interval — conflating them would either over-poll for epics or under-poll for labels. The orchestrator already manages multiple services with independent lifecycles.

### 4. Epic-specific gate mapping (Q4: Option A)

**Decision**: `WORKFLOW_GATE_MAPPING` keyed by workflow name.

**Rationale**: With workflow-driven phase sequences, making gate mappings workflow-aware is consistent. For epics, `tasks-review` maps to child creation (not `implement`). The `PhaseResolver` already receives labels and command — adding `workflowName` is a minor change.

### 5. FIFO queue with immediate trigger labels (Q5: Option A, Q11: Option A)

**Decision**: Children get `process:speckit-feature` immediately. No priority boost.

**Rationale**: The Redis queue with `maxConcurrentWorkers` provides natural throttling. Children queue alongside other work and process as slots free up. Adding dispatch orchestration or priority mechanisms would add complexity for a problem the queue already solves.

### 6. Specialized `epic-complete` command handler (Q6: Option B)

**Decision**: `epic-complete` as a fourth command type with `EpicCompletionHandler`.

**Rationale**: Mirrors the `PrFeedbackHandler` pattern exactly. Clean separation — epic completion logic stays out of the generic phase loop. The handler calls `epic.create_pr` and `epic.close` directly (deterministic, no CLI needed).

### 7. Manual trigger for rollup PR merge detection (Q7: Option C)

**Decision**: Human adds `completed:epic-approval` label after merging the rollup PR.

**Rationale**: Consistent with the existing gate pattern. Every other human decision point uses `waiting-for:X` / `completed:X` labels. Merging a PR is already manual — adding a label is trivial overhead. Avoids new webhook infrastructure.

### 8. GitHub search only for epic state (Q9: Option A)

**Decision**: No Redis for epic-to-children mappings. Use `"epic-parent: #N" in:body` search.

**Rationale**: The 5-minute poll interval makes GitHub's 30-60 second indexing delay negligible. GitHub is the source of truth. Avoids cache invalidation concerns. Redis can be added later as optimization if needed.

### 9. Separate `<!-- epic-status -->` comment (Q10: Option B)

**Decision**: Epic-specific progress uses a separate comment from stage comments.

**Rationale**: The existing `StageCommentManager` with 3 stages works well for standard workflows. Epic progress (child completion table, rollup PR status) serves a different purpose and evolves independently. Two comments on the same issue is fine.

### 10. Structured markdown with YAML frontmatter for tasks (Q12: Option A)

**Decision**: Tasks.md uses YAML frontmatter per task section.

**Rationale**: Deterministic parsing requires a well-defined format. The `speckit.tasks` phase prompt can be configured to output this format. Fallback parsing handles existing unstructured tasks.md files gracefully.

### 11. Children branch from epic branch (Q13: Option A)

**Decision**: Child branches created from epic branch, PRs target epic branch, rollup PR merges epic to develop.

**Rationale**: Atomic epic merging — all child work collects on the epic branch. A single rollup PR merges everything to develop/main. The orchestrator change is minor — pass `baseBranch` from issue body metadata.

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| tasks.md format varies across AI runs | Medium | High | Fallback parser for unstructured format; validate in tests |
| GitHub search indexing delay for child issues | Low | Low | 5-min poll interval absorbs 30-60s delay |
| Partial child creation failure | Medium | Medium | Idempotent retry via `epic-parent: #N` marker search |
| Epic branch merge conflicts with develop | Medium | Medium | Children branch from epic branch (not develop); conflicts resolved at rollup PR |
| PhaseLoop refactor breaks existing workflows | Low | High | Optional parameter with fallback; all existing tests must pass |
| Child issue flood overwhelming queue | Low | Medium | FIFO queue with `maxConcurrentWorkers` provides natural throttling |
| LabelMonitorService doesn't recognize epic labels | Low | Medium | Add epic labels to `WORKFLOW_LABELS` and label sync |
| Worker picks up child issue before epic branch exists | Medium | Medium | Epic branch created during specify phase; child creation only happens after tasks phase |

---

## Appendix: Clarification Answers Applied

| Q# | Answer | Implementation Impact |
|----|--------|----------------------|
| Q1 | C: Workflow-driven phase registry | `WORKFLOW_PHASE_SEQUENCES` map, `getPhaseSequence()` |
| Q2 | B: Direct workflow-engine action | `speckit.tasks_to_issues` action, called from worker |
| Q3 | B: Separate EpicCompletionMonitorService | New service, 5-min polling, independent lifecycle |
| Q4 | A: Epic-specific gate mapping | `WORKFLOW_GATE_MAPPING`, workflow-aware `PhaseResolver` |
| Q5 | A: Immediate trigger with same label | Children get `process:speckit-feature` at creation |
| Q6 | B: Specialized command handler | `epic-complete` command, `EpicCompletionHandler` |
| Q7 | C: Manual trigger via label | `completed:epic-approval` after rollup PR merge |
| Q8 | B: Idempotent retry | `epic-parent: #N` body marker search for dedup |
| Q9 | A: GitHub search only | No Redis for epic state, direct search on poll |
| Q10 | B: Separate epic status comment | `<!-- epic-status -->` marker, independent of stage comments |
| Q11 | A: FIFO only | No priority boost for epic children |
| Q12 | A: Structured markdown with frontmatter | YAML frontmatter parser with fallback |
| Q13 | A: Children branch from epic branch | `epic-branch` in issue body, `baseBranch` parameter |
| Q14 | A: Manual override only | Human adds `completed:children-complete` for stuck epics |

---

*End of Implementation Plan*
