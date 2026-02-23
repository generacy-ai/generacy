# Data Model: Job Log Types

**Feature**: #180 — Live Log/Conversation Viewer

## New Types

### JobLogLine

Single log line from a job's claude CLI output.

```typescript
interface JobLogLine {
  /** Log line content (pre-cleaned, no ANSI codes) */
  content: string;
  /** Output stream source */
  stream: 'stdout' | 'stderr';
  /** Line timestamp (ISO datetime) */
  timestamp: string;
  /** Current step name when this line was emitted */
  stepName?: string;
}
```

**Zod schema:**
```typescript
const JobLogLineSchema = z.object({
  content: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  timestamp: z.string().datetime(),
  stepName: z.string().optional(),
});
```

### JobLogsResponse

Response from historical log fetch endpoint.

```typescript
interface JobLogsResponse {
  /** Log lines (most recent N) */
  lines: JobLogLine[];
  /** Total number of log lines for this job */
  total: number;
  /** Cursor for SSE handoff (pass as Last-Event-ID to resume without gaps) */
  cursor?: string;
  /** Whether the response was truncated (total > lines.length) */
  truncated: boolean;
}
```

**Zod schema:**
```typescript
const JobLogsResponseSchema = z.object({
  lines: z.array(JobLogLineSchema),
  total: z.number().int().nonnegative(),
  cursor: z.string().optional(),
  truncated: z.boolean(),
});
```

## Modified Types

### SSEChannel

Add `'jobs'` to the channel union.

```typescript
// Before
type SSEChannel = 'workflows' | 'queue' | 'agents';

// After
type SSEChannel = 'workflows' | 'queue' | 'agents' | 'jobs';
```

### JobDetailWebviewMessage

Add `viewLogs` message variant.

```typescript
// Before
type JobDetailWebviewMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'pin' }
  | { type: 'togglePhase'; phaseId: string }
  | { type: 'openPR'; url: string }
  | { type: 'openAgent'; agentId: string };

// After (added)
  | { type: 'viewLogs' };
```

## SSE Event Data Types

### JobLogEventData

Payload for `job:log` SSE events.

```typescript
interface JobLogEventData {
  jobId: string;
  content: string;
  stream: 'stdout' | 'stderr';
  stepName?: string;
  timestamp: string;
}
```

### JobStepBoundaryEventData

Payload for `job:step-start` SSE events.

```typescript
interface JobStepBoundaryEventData {
  jobId: string;
  stepName: string;
  stepIndex: number;
  totalSteps: number;
}
```

### JobLogEndEventData

Payload for `job:log:end` SSE events.

```typescript
interface JobLogEndEventData {
  jobId: string;
  status: 'completed' | 'failed' | 'cancelled';
  completedAt: string;
}
```

## Relationship to Existing Types

```
QueueItem (existing)
  └── id ──────────── JobLogChannel tracks by this
  └── workflowName ── Used for OutputChannel naming
  └── status ──────── Determines "waiting" vs active state

SSEEvent<T> (existing)
  └── channel: 'jobs' ── New channel for log events
  └── data: JobLogEventData | JobStepBoundaryEventData | JobLogEndEventData

AgentLogLine (existing, reference pattern)
  └── line: string
  └── timestamp?: string

JobLogLine (new, similar but richer)
  └── content: string    (renamed from 'line' for clarity)
  └── stream: string     (stdout/stderr distinction)
  └── timestamp: string  (required, not optional)
  └── stepName?: string  (step context)
```
