# Data Model: tasks.md safety net

## Entities

### `TasksMdEvaluation` (new — `tasks-md-fallback.ts`)

Discriminated union returned by the evaluator. The `kind` discriminant drives the
phase-loop decision.

```ts
export type TasksMdEvaluation =
  | {
      kind: 'incomplete';
      unchecked: number;   // ≥ 1
      checked: number;     // ≥ 0
      total: number;       // = unchecked + checked
    }
  | {
      kind: 'complete';
      unchecked: 0;
      checked: number;     // ≥ 0
      total: number;       // ≥ 0 (0 ⇒ task-less story per FR-004/Q4-A)
    }
  | {
      kind: 'unreadable';
      reason: string;      // human-readable FR-006 log reason
    };
```

**Invariants**:
- `incomplete.total === incomplete.unchecked + incomplete.checked`.
- `complete.unchecked === 0` always.
- `unreadable` carries no counts — the story advances and the reason is logged.

### `TaskCounts` (internal helper shape)

Pure output of the checkbox parser over a string of tasks.md content.

```ts
interface TaskCounts {
  unchecked: number;   // lines matching `- [ ]`
  checked: number;     // lines matching `- [x]` / `- [X]`
  total: number;       // unchecked + checked (non-task lines excluded)
}
```

### `ImplementPartialResult` (existing — `types.ts:178`, reused unchanged)

```ts
interface ImplementPartialResult {
  partial?: boolean;
  tasks_completed?: number;
  tasks_remaining?: number;
  tasks_total?: number;
}
```

## Synthesis mapping (fallback → existing block)

When `TasksMdEvaluation.kind === 'incomplete'`, the phase-loop synthesis block
maps it onto the reused `ImplementPartialResult`:

| `TasksMdEvaluation` field | `ImplementPartialResult` field |
|---------------------------|--------------------------------|
| `unchecked`               | `tasks_remaining`              |
| `checked`                 | `tasks_completed`              |
| `total`                   | `tasks_total`                  |
| — (constant)              | `partial: true`               |

The existing block at `phase-loop.ts:873` reads `tasks_remaining` for both the
no-progress guard (FR-003) and the WIP commit message, so no further mapping is
needed.

## Decision matrix (evaluator → phase-loop action)

| `kind`       | Synthesize `implementResult`? | Phase-loop outcome                         |
|--------------|-------------------------------|--------------------------------------------|
| `incomplete` | yes (`partial: true`)         | Existing 873 block re-enters implement     |
| `complete`   | no                            | Advance → grant `completed:implement`      |
| `unreadable` | no                            | Advance → grant `completed:implement` + log FR-006 reason |

## State transitions

```
implement success, no sentinel (implementResult === undefined)
        │
        ▼
   evaluateTasksMd(context)
        │
   ┌────┴───────────────┬──────────────────────┐
   ▼                    ▼                      ▼
incomplete           complete              unreadable
   │                    │                      │
synth implementResult   │                  log FR-006
   │                    │                      │
 block:873 …            └──────────┬───────────┘
   │                               ▼
 no-progress guard?          advance to review
   ├── decreased → i--; continue (re-enter implement)
   └── not decreased → escalate, completed:false
```

## Injection

`PhaseLoopDeps` (existing interface, `phase-loop.ts`) gains one optional field:

```ts
evaluateTasksMd?: (context: WorkerContext) => TasksMdEvaluation;
```

Default (production) is the FS-backed evaluator from `tasks-md-fallback.ts`, wired
in `claude-cli-worker.ts`. Tests inject a stub returning a fixed
`TasksMdEvaluation`.
