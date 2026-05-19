# Data Model: ProcessFactory uid/gid Extension

## Interface Change

### ProcessFactory (before)

```typescript
// packages/orchestrator/src/worker/types.ts:269-275
export interface ProcessFactory {
  spawn(
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string>; signal?: AbortSignal },
  ): ChildProcessHandle;
}
```

### ProcessFactory (after)

```typescript
export interface ProcessFactory {
  spawn(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      signal?: AbortSignal;
      uid?: number;
      gid?: number;
    },
  ): ChildProcessHandle;
}
```

### Fields Added

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `uid` | `number` | No | `undefined` | Unix user ID for spawned process |
| `gid` | `number` | No | `undefined` | Unix group ID for spawned process |

### Validation Rules

- Both fields are optional (`undefined` = use current process identity)
- When `undefined`, the keys must not appear in the `child_process.spawn` options object (FR-005)
- Type is `number` matching Node.js `child_process.SpawnOptions.uid` / `.gid`

## Unchanged Interfaces

- `ChildProcessHandle` — no changes
- All caller signatures — no changes (options are optional)
