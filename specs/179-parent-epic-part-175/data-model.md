# Data Model: Job Progress Types and Schemas

**Feature**: 179-parent-epic-part-175
**Date**: 2026-02-23

## Overview

This document defines the new types needed to represent real-time job progress at the phase and step level. These types are used by:
1. The `QueueTreeProvider` for summary progress in tree items
2. The `JobDetailPanel` webview for full phase/step breakdown
3. The SSE event handlers for incremental and snapshot updates
4. The queue API response extensions for initial data loading

## New Types (added to `api/types.ts`)

### PhaseStatus

```typescript
type PhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
```

### StepStatus

```typescript
type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
```

### StepProgress

```typescript
interface StepProgress {
  /** Step identifier (e.g., "T001") */
  id: string;
  /** Step display name */
  name: string;
  /** Current status */
  status: StepStatus;
  /** Start timestamp (ISO datetime) */
  startedAt?: string;
  /** Completion timestamp (ISO datetime) */
  completedAt?: string;
  /** Duration in milliseconds (set on completion) */
  durationMs?: number;
  /** Single-line summary output (e.g., "Generated 3 files") */
  output?: string;
  /** Error message if failed */
  error?: string;
}
```

### PhaseProgress

```typescript
interface PhaseProgress {
  /** Phase identifier (e.g., "setup", "implementation") */
  id: string;
  /** Phase display name */
  name: string;
  /** Current status */
  status: PhaseStatus;
  /** Start timestamp (ISO datetime) */
  startedAt?: string;
  /** Completion timestamp (ISO datetime) */
  completedAt?: string;
  /** Duration in milliseconds (set on completion) */
  durationMs?: number;
  /** Steps within this phase */
  steps: StepProgress[];
  /** Error message if phase failed */
  error?: string;
}
```

### JobProgress

The full progress snapshot for a job. Sent in `workflow:progress` snapshot events and returned by `GET /queue/:id/progress`.

```typescript
interface JobProgress {
  /** Queue item / job ID */
  jobId: string;
  /** Current phase index (0-based) */
  currentPhaseIndex: number;
  /** Total number of phases */
  totalPhases: number;
  /** Number of completed phases */
  completedPhases: number;
  /** Number of skipped phases */
  skippedPhases: number;
  /** All phases with their step-level detail */
  phases: PhaseProgress[];
  /** PR URL when pr-creation phase completes */
  pullRequestUrl?: string;
  /** Last updated timestamp */
  updatedAt: string;
}
```

### QueueItemSummary (extension to QueueItem)

Lightweight progress summary added to the `QueueItem` list response. Avoids fetching full progress for every item in the tree view.

```typescript
interface QueueItemProgressSummary {
  /** Current phase name (e.g., "implementation") */
  currentPhase?: string;
  /** Progress string for display (e.g., "Phase 5/8") */
  phaseProgress?: string;
  /** Total phases count */
  totalPhases?: number;
  /** Completed phases count */
  completedPhases?: number;
  /** Skipped phases count */
  skippedPhases?: number;
}
```

The existing `QueueItem` interface is extended:

```typescript
interface QueueItem {
  // ... existing fields ...
  /** Lightweight progress summary (present for running/completed items) */
  progress?: QueueItemProgressSummary;
}
```

## Zod Schemas

```typescript
const StepStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);
const PhaseStatusSchema = z.enum(['pending', 'running', 'completed', 'failed', 'skipped']);

const StepProgressSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: StepStatusSchema,
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative().optional(),
  output: z.string().optional(),
  error: z.string().optional(),
});

const PhaseProgressSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: PhaseStatusSchema,
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().nonnegative().optional(),
  steps: z.array(StepProgressSchema),
  error: z.string().optional(),
});

const JobProgressSchema = z.object({
  jobId: z.string(),
  currentPhaseIndex: z.number().int().nonnegative(),
  totalPhases: z.number().int().nonnegative(),
  completedPhases: z.number().int().nonnegative(),
  skippedPhases: z.number().int().nonnegative(),
  phases: z.array(PhaseProgressSchema),
  pullRequestUrl: z.string().url().optional(),
  updatedAt: z.string().datetime(),
});

const QueueItemProgressSummarySchema = z.object({
  currentPhase: z.string().optional(),
  phaseProgress: z.string().optional(),
  totalPhases: z.number().int().nonnegative().optional(),
  completedPhases: z.number().int().nonnegative().optional(),
  skippedPhases: z.number().int().nonnegative().optional(),
});
```

## SSE Event Payloads

### New Workflow SSE Event Types

Added to the `workflows` SSE channel. These complement the existing `workflow:started`, `workflow:completed`, `workflow:failed`, etc.

| Event Type | Payload | Frequency | Description |
|---|---|---|---|
| `workflow:progress` | `JobProgress` (full snapshot) | Every ~10s for running jobs | Full state snapshot for recovery and sync |
| `workflow:phase:start` | `WorkflowPhaseEventData` | Per phase start | Incremental: phase has begun |
| `workflow:phase:complete` | `WorkflowPhaseEventData` | Per phase completion | Incremental: phase finished |
| `workflow:step:start` | `WorkflowStepEventData` | Per step start | Incremental: step has begun |
| `workflow:step:complete` | `WorkflowStepEventData` | Per step completion | Incremental: step finished |

### WorkflowPhaseEventData

```typescript
interface WorkflowPhaseEventData {
  workflowId: string;
  jobId: string;
  phase: PhaseProgress;
  phaseIndex: number;
  totalPhases: number;
}
```

### WorkflowStepEventData

```typescript
interface WorkflowStepEventData {
  workflowId: string;
  jobId: string;
  phaseId: string;
  phaseIndex: number;
  step: StepProgress;
  stepIndex: number;
  totalSteps: number;
}
```

## API Endpoint Extensions

### GET /queue (list) — Extended Response

The `QueueItem` objects in the list response now include an optional `progress` summary field:

```json
{
  "items": [
    {
      "id": "abc-123",
      "workflowName": "Fix request_decision options",
      "status": "running",
      "priority": "normal",
      "progress": {
        "currentPhase": "implementation",
        "phaseProgress": "Phase 5/8",
        "totalPhases": 8,
        "completedPhases": 4,
        "skippedPhases": 0
      }
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 50
}
```

### GET /queue/:id/progress — New Endpoint

Returns the full `JobProgress` object for a specific queue item.

**Response**: `JobProgress`

```json
{
  "jobId": "abc-123",
  "currentPhaseIndex": 4,
  "totalPhases": 8,
  "completedPhases": 4,
  "skippedPhases": 0,
  "phases": [
    {
      "id": "setup",
      "name": "Setup",
      "status": "completed",
      "startedAt": "2026-02-23T10:00:00Z",
      "completedAt": "2026-02-23T10:00:00Z",
      "durationMs": 32,
      "steps": []
    },
    {
      "id": "implementation",
      "name": "Implementation",
      "status": "running",
      "startedAt": "2026-02-23T10:09:36Z",
      "steps": [
        {
          "id": "T001",
          "name": "Extract conversion function",
          "status": "completed",
          "durationMs": 120000,
          "output": "Created src/utils/convert.ts"
        },
        {
          "id": "T003",
          "name": "Clear baseline.rec",
          "status": "running",
          "startedAt": "2026-02-23T10:14:36Z"
        }
      ]
    }
  ],
  "updatedAt": "2026-02-23T10:14:36Z"
}
```

## Webview Message Types

### JobDetailPanel Messages (webview → extension)

```typescript
type JobDetailWebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'pin' }
  | { type: 'togglePhase'; phaseId: string }
  | { type: 'openPR'; url: string }
  | { type: 'openAgent'; agentId: string };
```

### JobDetailPanel Messages (extension → webview)

```typescript
type JobDetailExtensionMessage =
  | { type: 'update'; data: { item: QueueItem; progress: JobProgress | null } }
  | { type: 'progressUpdate'; progress: JobProgress }
  | { type: 'phaseEvent'; event: WorkflowPhaseEventData }
  | { type: 'stepEvent'; event: WorkflowStepEventData }
  | { type: 'connectionStatus'; connected: boolean; reconnecting?: boolean }
  | { type: 'error'; message: string };
```

## State Management in JobDetailPanel

The panel maintains a local `JobProgress` object, updated by:

1. **Initial load**: `GET /queue/:id/progress` → full `JobProgress`
2. **Incremental events**: `workflow:phase:*` and `workflow:step:*` → merge into local state
3. **Periodic snapshots**: `workflow:progress` → replace entire local state (recovery)
4. **Polling fallback**: During SSE disconnect, `GET /queue/:id/progress` every 5s

State merging for incremental events:
- `workflow:phase:start` → Find phase by ID, update status to `running`, set `startedAt`
- `workflow:phase:complete` → Find phase by ID, update status to `completed`, set `completedAt` and `durationMs`
- `workflow:step:start` → Find phase by ID, find step by ID, update status to `running`, set `startedAt`
- `workflow:step:complete` → Find phase by ID, find step by ID, update status to `completed`, set `completedAt`, `durationMs`, `output`
