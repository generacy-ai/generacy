# Data Model: Failed Phase Labels

## Core Types

### WorkflowPhase (existing, unchanged)
```typescript
// packages/orchestrator/src/worker/types.ts
type WorkflowPhase = 'specify' | 'clarify' | 'plan' | 'tasks' | 'implement' | 'validate';
```

### Label Definition (existing structure)
```typescript
// packages/workflow-engine/src/actions/github/label-definitions.ts
interface LabelDefinition {
  name: string;
  color: string;
  description: string;
}
```

## New Labels

| Label Name | Color | Description |
|-----------|-------|-------------|
| `failed:specify` | `D73A4A` | Phase specify failed |
| `failed:clarify` | `D73A4A` | Phase clarify failed |
| `failed:plan` | `D73A4A` | Phase plan failed |
| `failed:tasks` | `D73A4A` | Phase tasks failed |
| `failed:implement` | `D73A4A` | Phase implement failed |
| `failed:validate` | `D73A4A` | Phase validate failed |

## New Constant

```typescript
// packages/orchestrator/src/services/label-monitor-service.ts
const FAILED_LABEL_PREFIX = 'failed:';
```

## Label State Machine

```
Issue Created
  │
  ▼
[process:* added] ──→ Clear: completed:*, failed:*, agent:error
  │                    Add: agent:in-progress, workflow:*
  ▼
[phase:<name>] ──→ Phase running
  │
  ├─ Success ──→ Remove: phase:<name>
  │               Add: completed:<phase>
  │               Continue to next phase
  │
  └─ Failure ──→ Remove: phase:<name>, agent:in-progress
                  Add: failed:<phase>, agent:error        ← NEW
                  Workflow stops
```

## Relationships

- `failed:<phase>` is mutually exclusive with `completed:<phase>` for the same phase
- `failed:<phase>` always co-occurs with `agent:error`
- `failed:<phase>` is cleared on reprocessing (same lifecycle as `completed:<phase>`)
