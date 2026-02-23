# Data Model: Event Forwarding Types

## Event Type Mapping

No new types or schemas are introduced. This feature maps between two existing type systems:

### Source: `ExecutionEvent` (workflow-engine)

```typescript
// packages/workflow-engine/src/types/events.ts
interface ExecutionEvent {
  type: ExecutionEventType;    // 14 event types
  timestamp: number;           // Unix epoch ms
  workflowName: string;
  phaseName?: string;
  stepName?: string;
  message?: string;
  data?: unknown;
}
```

### Target: `publishEvent()` payload (orchestrator)

```typescript
// packages/generacy/src/orchestrator/client.ts:185-190
{
  type: JobEventType;                    // 8 event types
  data: Record<string, unknown>;         // Event payload
  timestamp?: number;                    // Unix epoch ms
}
```

### Mapping Table

| Source (`ExecutionEvent`) | Target (`JobEventType`) | `data` payload |
|---|---|---|
| `phase:start` | `phase:start` | `{ workflowName, phaseName }` |
| `phase:complete` | `phase:complete` | `{ workflowName, phaseName, detail }` |
| `step:start` | `step:start` | `{ workflowName, phaseName, stepName }` |
| `step:complete` | `step:complete` | `{ workflowName, phaseName, stepName, progress, detail }` |
| `step:output` | `step:output` | `{ workflowName, phaseName, stepName, message, detail }` |
| `action:error` | `action:error` | `{ workflowName, phaseName, stepName, message, detail }` |
| `action:retry` | `action:error` | `{ workflowName, phaseName, stepName, message, detail }` |

### `data` Field Definitions

| Field | Type | Description |
|-------|------|-------------|
| `workflowName` | `string` | Name of the executing workflow |
| `phaseName` | `string` | Name of the current phase (when applicable) |
| `stepName` | `string` | Name of the current step (when applicable) |
| `message` | `string` | Human-readable message from the executor |
| `detail` | `unknown` | Raw `event.data` from the executor (step output, error details, etc.) |
| `progress` | `number` | Overall completion percentage (0-100), only on `step:complete` events |

## Internal Queue Item

Not a persisted type — used only within the `createEventForwarder()` closure:

```typescript
// Shape of items in the forwarding queue
{
  type: JobEventType;
  data: Record<string, unknown>;
  timestamp: number;
}
```

This matches the `publishEvent()` method signature directly.
