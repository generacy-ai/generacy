# Data Model: Task Chunking with Session Restart

## Type Changes

### ImplementInput (workflow-engine/types.ts)

```typescript
export interface ImplementInput {
  feature_dir: string;
  task_filter?: string;
  timeout?: number;
  max_tasks_per_increment?: number;  // NEW — default: 10
}
```

**Validation**: `max_tasks_per_increment` must be a positive integer if provided. Values < 1 are treated as 1; no upper bound enforced (consumer's responsibility).

### ImplementOutput (workflow-engine/types.ts)

```typescript
export interface ImplementOutput {
  success: boolean;
  tasks_completed: number;
  tasks_total: number;
  tasks_skipped: number;
  files_modified: string[];
  tests_passed?: boolean;
  errors?: string[];
  partial?: boolean;         // NEW — true if more tasks remain in this increment
  tasks_remaining?: number;  // NEW — count of pending tasks not yet started
}
```

**Invariants**:
- `partial: true` implies `tasks_remaining > 0`
- `partial` is only set when `success: true` (failed operations don't partial-complete)
- `tasks_completed + tasks_skipped + tasks_remaining = tasks_total` (approximately — parallel batches counted as batch size)

### ImplementPartialResult (orchestrator/types.ts)

New interface to carry parsed partial result in PhaseResult:

```typescript
export interface ImplementPartialResult {
  partial?: boolean;
  tasks_completed?: number;
  tasks_remaining?: number;
  tasks_total?: number;
}
```

### PhaseResult (orchestrator/types.ts)

```typescript
export interface PhaseResult {
  phase: WorkflowPhase;
  success: boolean;
  exitCode: number;
  durationMs: number;
  output: OutputChunk[];
  sessionId?: string;
  gateHit?: { gateLabel: string; reason: string };
  error?: { message: string; stderr: string; phase: WorkflowPhase };
  implementResult?: ImplementPartialResult;  // NEW — populated for implement phase
}
```

## Sentinel Protocol

The implement.md command emits this exact text line when `partial: true`:

```
SPECKIT_IMPLEMENT_PARTIAL: {"partial":true,"tasks_completed":<N>,"tasks_remaining":<M>,"tasks_total":<T>}
```

- Prefix: `SPECKIT_IMPLEMENT_PARTIAL: ` (with trailing space)
- Body: JSON conforming to `ImplementPartialResult`
- Emitted as a text line in Claude CLI stream-json stdout

**Detection in output-capture.ts**:
```typescript
if (type === 'text' && typeof parsed.text === 'string' && parsed.text.startsWith('SPECKIT_IMPLEMENT_PARTIAL: ')) {
  const json = parsed.text.slice('SPECKIT_IMPLEMENT_PARTIAL: '.length);
  try {
    this._implementResult = JSON.parse(json) as ImplementPartialResult;
  } catch { /* ignore malformed sentinel */ }
}
```

## State in Phase Loop

New variables in `executeLoop`:
```typescript
let lastTasksRemaining: number | undefined;  // Guard against infinite loop
```

Reset logic: `lastTasksRemaining` is only checked/updated during implement phase re-invocations. It's declared in loop scope and naturally resets if the loop ever exits and re-enters implement (which can't happen in current design, but safe regardless).

## Counter Logic in implement.ts

```typescript
const MAX_TASKS = input.max_tasks_per_increment ?? 10;
let tasksThisIncrement = 0;

for (const task of pendingTasks) {
  // Check limit BEFORE starting sequential task
  if (tasksThisIncrement >= MAX_TASKS) {
    // Return partial — phase loop will re-invoke
    return {
      success: true,
      partial: true,
      tasks_remaining: pendingTasks.length - completedTasks.length,
      tasks_completed: completedTasks.length,
      tasks_total: tasks.length,
      tasks_skipped: skippedTasks.length,
      files_modified: [...filesModified],
    };
  }

  // Execute task...
  // On success:
  tasksThisIncrement++;
}
```

For parallel batches (when implemented): check limit before starting the batch; add `batch.length` to `tasksThisIncrement` after batch completes.
