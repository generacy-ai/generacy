# Data Model: Epic Processing Support

## New Types

### Orchestrator (`packages/orchestrator/src/`)

#### `QueueItem` Extension (types/monitor.ts)

```typescript
export interface QueueItem {
  owner: string;
  repo: string;
  issueNumber: number;
  workflowName: string;
  command: 'process' | 'continue' | 'address-pr-feedback' | 'epic-complete';  // NEW: epic-complete
  priority: number;
  enqueuedAt: string;
  metadata?: Record<string, unknown>;
}
```

#### Workflow Phase Sequences (worker/types.ts)

```typescript
/**
 * Per-workflow phase sequence registry.
 */
export const WORKFLOW_PHASE_SEQUENCES: Record<string, WorkflowPhase[]> = {
  'speckit-feature': ['specify', 'clarify', 'plan', 'tasks', 'implement', 'validate'],
  'speckit-bugfix':  ['specify', 'clarify', 'plan', 'tasks', 'implement', 'validate'],
  'speckit-epic':    ['specify', 'clarify', 'plan', 'tasks'],
};
```

#### Workflow Gate Mapping (worker/phase-resolver.ts)

```typescript
/**
 * Per-workflow gate overrides.
 * When a workflow has an entry here, it takes precedence over the global GATE_MAPPING.
 */
export const WORKFLOW_GATE_MAPPING: Record<string, Record<string, {
  phase: WorkflowPhase;
  resumeFrom: WorkflowPhase;
}>> = {
  'speckit-epic': {
    'tasks-review':       { phase: 'tasks', resumeFrom: 'tasks' },
    'children-complete':  { phase: 'tasks', resumeFrom: 'tasks' },
    'epic-approval':      { phase: 'tasks', resumeFrom: 'tasks' },
  },
};
```

#### Epic Monitor Config (config/schema.ts)

```typescript
export const EpicMonitorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  pollIntervalMs: z.number().int().min(60000).default(300000),
});

export type EpicMonitorConfig = z.infer<typeof EpicMonitorConfigSchema>;
```

### Workflow Engine (`packages/workflow-engine/src/`)

#### Task Parsing Types (types/github.ts)

```typescript
export interface TasksToIssuesInput {
  feature_dir: string;
  epic_issue_number: number;
  epic_branch: string;
  trigger_label?: string;   // default: 'process:speckit-feature'
}

export interface TasksToIssuesOutput {
  created_issues: number[];
  skipped_issues: number[];
  failed_tasks: Array<{ task_title: string; reason: string }>;
  total_tasks: number;
}

export interface ParsedTask {
  title: string;
  type?: string;            // 'feature' | 'bugfix' | 'refactor'
  labels?: string[];
  description: string;
  task_id: string;          // e.g., 'T001'
}
```

---

## Label Lifecycle

### Epic Processing Labels

| Label | Set by | Removed by | Purpose |
|-------|--------|------------|---------|
| `type:epic` | Human (manual) | Never | Identifies epic issues |
| `process:speckit-epic` | Human (trigger) | LabelMonitorService | Triggers epic workflow |
| `workflow:speckit-epic` | LabelMonitorService | LabelManager (cleanup) | Tracks workflow type |
| `agent:in-progress` | LabelMonitorService | LabelManager | Worker is processing |
| `phase:specify` | LabelManager | LabelManager (next phase) | Current phase |
| `completed:specify` | LabelManager | Never | Phase completed |
| `waiting-for:clarification` | GateChecker | LabelManager (resume) | Paused for clarification |
| `completed:clarification` | Human | Never | Gate satisfied |
| `waiting-for:tasks-review` | GateChecker | LabelManager (resume) | Paused for tasks review |
| `completed:tasks-review` | Human | Never | Gate satisfied |
| `waiting-for:children-complete` | EpicPostTasks | EpicCompletionMonitor | Waiting for all children |
| `completed:children-complete` | EpicCompletionMonitor | EpicCompletionHandler | All children done |
| `waiting-for:epic-approval` | EpicCompletionHandler | EpicCompletionHandler | Rollup PR needs approval |
| `completed:epic-approval` | Human | EpicCompletionHandler | PR approved/merged |

### Child Issue Labels

| Label | Set by | Removed by | Purpose |
|-------|--------|------------|---------|
| `epic-child` | speckit.tasks_to_issues | Never | Identifies child issues |
| `process:speckit-feature` | speckit.tasks_to_issues | LabelMonitorService | Triggers child workflow |
| `agent:dispatched` | epic.dispatch_children | Never | Child assigned to agent |

---

## GitHub Issue Body Markers

### Child Issue Body Format

```markdown
epic-parent: #195
task: T001
epic-branch: 195-implement-epic-processing

## Implement user authentication

Description of the task from tasks.md...
```

**Markers used for:**
- `epic-parent: #N` — GitHub search to find children of an epic
- `task: TXXX` — Idempotency check (skip if child already exists for this task)
- `epic-branch: {branch}` — Tells the worker to branch from epic branch

### Epic Status Comment Format

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

---

## tasks.md Structured Format

```markdown
## Task 1
---
title: Implement user authentication
type: feature
labels: [auth, security]
---

Description of the authentication task...

## Task 2
---
title: Fix login redirect bug
type: bugfix
labels: [auth]
---

Description of the bug fix...
```

### Parsing Rules

1. Task sections start with `## Task N` or `### TXXX` headings
2. YAML frontmatter between `---` delimiters (optional)
3. `title` is required in frontmatter; `type` and `labels` are optional
4. Body text after second `---` until next heading = description
5. Fallback: if no frontmatter, heading text = title, section body = description

---

## State Machine: Epic Lifecycle

```
[New Issue]
    │ process:speckit-epic label added
    ▼
[Specify] → [Clarify] → [Plan] → [Tasks]
    │          │ gate                │ gate
    │          ▼                     ▼
    │    waiting-for:           waiting-for:
    │    clarification          tasks-review
    │          │                     │
    │    completed:             completed:
    │    clarification          tasks-review
    │          │                     │
    │          ▼                     ▼
    │    [Resume Plan]        [Create Children]
    │                                │
    │                                ▼
    │                     waiting-for:children-complete
    │                                │
    │                     (children process independently)
    │                                │
    │                     completed:children-complete
    │                                │
    │                                ▼
    │                      [Create Rollup PR]
    │                                │
    │                                ▼
    │                     waiting-for:epic-approval
    │                                │
    │                     (human merges PR + labels)
    │                                │
    │                     completed:epic-approval
    │                                │
    │                                ▼
    │                        [Close Epic]
    │                                │
    ▼                                ▼
                              [Complete]
```
