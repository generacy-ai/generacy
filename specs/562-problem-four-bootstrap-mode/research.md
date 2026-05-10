# Research: bootstrap-complete lifecycle action

**Feature**: #562 | **Date**: 2026-05-10

## Technology Decisions

### 1. Sentinel File Pattern

**Decision**: Write an empty file at a configurable path to signal completion.

**Rationale**: The `post-activation-watcher.sh` in cluster-base uses `inotifywait` to watch for file creation at `/tmp/generacy-bootstrap-complete`. It checks existence only — no content parsing. This is the simplest reliable IPC mechanism for shell-to-Node coordination.

**Alternatives Considered**:
- Unix signal (SIGUSR1): Requires PID tracking; less reliable across container restarts.
- Named pipe / Unix socket: Over-engineered for a one-shot signal.
- File with timestamp content: Spec explicitly excludes this (out of scope).

### 2. No Service File Extraction

**Decision**: Implement directly in `lifecycle.ts` handler.

**Rationale**: The implementation is 3 lines: read env, write file, respond. Extracting to a service file (like `default-role-writer.ts` or `peer-repo-cloner.ts`) would add indirection with zero benefit. Those services exist because they have complex logic (YAML parsing, git clone, relay events). This handler has none.

### 3. Env Var for Path Configuration

**Decision**: Use `POST_ACTIVATION_TRIGGER` env var, default `/tmp/generacy-bootstrap-complete`.

**Rationale**: This matches the contract in `post-activation-watcher.sh` (cluster-base#22), which reads the same env var to determine which path to watch. Using the same env var name ensures both sides agree without coupling.

### 4. No Relay Event Emission

**Decision**: Do not emit a relay event for bootstrap-complete.

**Rationale**: The cloud already knows bootstrap is complete — it initiated the action. Emitting back would create a redundant loop. The `POST /internal/status` endpoint already handles cluster state transitions (bootstrapping -> ready) separately.

## Implementation Pattern

The handler follows the exact pattern of the `stop` stub (simplest existing handler), extended with a file write:

```typescript
// Pattern from existing lifecycle.ts
} else if (parsed.data === 'stop') {
  res.writeHead(200);
  res.end(JSON.stringify({ accepted: true, action: parsed.data }));
}

// New handler follows same pattern + file write
} else if (parsed.data === 'bootstrap-complete') {
  const sentinel = process.env.POST_ACTIVATION_TRIGGER ?? '/tmp/generacy-bootstrap-complete';
  await writeFile(sentinel, '');
  res.writeHead(200);
  res.end(JSON.stringify({ accepted: true, action: parsed.data, sentinel }));
}
```

## Key Sources

- `packages/control-plane/src/routes/lifecycle.ts` — existing handler pattern
- `packages/control-plane/src/schemas.ts` — `LifecycleActionSchema` enum
- `packages/control-plane/__tests__/routes/lifecycle.test.ts` — test pattern
- cluster-base#22 — `post-activation-watcher.sh` sentinel contract
- generacy-cloud#532 — cloud-side lifecycle call (already merged)
