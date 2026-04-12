# Data Model: Phase 3 Cleanup

## Entities Being Removed

### PHASE_TO_COMMAND (DELETE)

```typescript
// packages/orchestrator/src/worker/types.ts — REMOVE
export const PHASE_TO_COMMAND: Record<WorkflowPhase, string | null> = {
  specify: '/specify',
  clarify: '/clarify',
  plan: '/plan',
  tasks: '/tasks',
  implement: '/implement',
  validate: null,
};
```

**Replacement**: Inline `phase === 'validate'` checks in phase-loop.ts; inline `` `/${phase}` `` derivation in cli-spawner.ts.

**Plugin equivalent** (already exists, no changes needed):
```typescript
// packages/generacy-plugin-claude-code/src/launch/constants.ts
export const PHASE_TO_COMMAND: Record<PhaseIntent['phase'], string> = {
  specify: '/specify',
  clarify: '/clarify',
  plan: '/plan',
  tasks: '/tasks',
  implement: '/implement',
};
```

Note: Plugin version excludes `validate` entirely (different type — `PhaseIntent['phase']` doesn't include `'validate'`).

### PTY_WRAPPER (DELETE from orchestrator)

```typescript
// packages/orchestrator/src/conversation/conversation-spawner.ts — REMOVE
const PTY_WRAPPER = [
  'import pty, os, sys',
  '# Prevent PTY line wrapping by setting huge terminal width',
  'os.environ["COLUMNS"] = "50000"',
  'def read(fd):',
  '    data = os.read(fd, 65536)',
  '    # Strip CRLF that PTY adds, return cleaned data',
  '    # (pty._copy writes our return value to stdout)',
  '    return data.replace(b"\\r\\n", b"\\n")',
  'pty.spawn(sys.argv[1:], read)',
].join('\n');
```

**Replacement**: Import from `@generacy-ai/generacy-plugin-claude-code` (identical copy already exists there).

### ConversationSpawnOptions (DELETE)

```typescript
// packages/orchestrator/src/conversation/conversation-spawner.ts — REMOVE
export interface ConversationSpawnOptions {
  cwd: string;
  model?: string;
  skipPermissions: boolean;
}
```

Only used by the deprecated `spawn()` method. Zero external consumers.

### ConversationSpawner.spawn() (DELETE)

```typescript
// packages/orchestrator/src/conversation/conversation-spawner.ts — REMOVE
/** @deprecated Use spawnTurn for per-message execution. */
spawn(options: ConversationSpawnOptions): ConversationProcessHandle { ... }
```

Zero callers. `ConversationManager` exclusively uses `spawnTurn()`.

## Entities Being Modified

### worker/index.ts re-exports

```typescript
// BEFORE
export {
  // ...
  PHASE_TO_COMMAND,
  // ...
} from './types.js';

// AFTER
export {
  // ...
  // PHASE_TO_COMMAND removed
  // ...
} from './types.js';
```

## Entities Unchanged

| Entity | File | Reason |
|--------|------|--------|
| `PHASE_SEQUENCE` | `worker/types.ts` | Still used by PhaseLoop, PhaseResolver |
| `PHASE_TO_STAGE` | `worker/types.ts` | Still used by PhaseLoop |
| `WorkflowPhase` type | `worker/types.ts` | Core type, widely used |
| `CliSpawner` class | `worker/cli-spawner.ts` | All methods actively called |
| `ConversationSpawner.spawnTurn()` | `conversation/conversation-spawner.ts` | Called by ConversationManager |
| `ConversationSpawner.gracefulKill()` | `conversation/conversation-spawner.ts` | Called by ConversationManager |
| `PrFeedbackHandler` | `worker/pr-feedback-handler.ts` | All methods actively called |
