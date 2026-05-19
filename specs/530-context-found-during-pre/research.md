# Research: Complete Cluster Control-Plane Lifecycle Handlers

## Technology Decisions

### 1. YAML Library Selection

**Decision**: Use `yaml` (v2.x) npm package

**Rationale**:
- Round-trip safe: preserves comments and formatting
- Well-maintained, zero subdependencies
- ~70KB bundled size
- Standard choice for TypeScript YAML manipulation
- Supports `parse()` / `stringify()` API

**Alternatives Rejected**:
- `js-yaml`: Older API, less TypeScript-friendly, loses comments on round-trip
- Regex-based editing: Fragile, breaks on comments/multi-line values
- `@iarna/toml` (convert to TOML): Unnecessary format change

### 2. Git Clone Strategy

**Decision**: Sequential `child_process.spawn('git', ['clone', ...])` with event emission between repos

**Rationale**:
- Bootstrap typically clones 1-3 peer repos (not performance-critical)
- Sequential simplifies error reporting (clear ordering of events)
- Spawn (not exec) allows streaming stdout for progress if needed later
- Token injection via URL rewriting (`x-access-token` pattern) avoids credential file creation

**Alternatives Rejected**:
- Parallel clone: More complex error handling, event ordering ambiguous
- `simple-git` library: Unnecessary dependency for 1 command
- `isomorphic-git`: Pure JS git is slower and doesn't support all clone features
- SSH-style clone: Out of v1.5 scope per spec

### 3. Relay Event Pattern

**Decision**: Reuse `setRelayPushEvent` from `src/routes/audit.ts`

**Rationale**:
- Already defined and (conceptually) wired in the codebase
- Channel-event API (`pushEventFn('cluster.bootstrap', data)`) matches use case
- No new DI patterns needed
- Test pattern already established in `audit-route.test.ts`

**Alternatives Rejected**:
- TunnelHandler-style constructor DI: Overkill for channel events, requires new wiring
- Direct relay WebSocket send: Bypasses abstraction, couples to transport

### 4. Config File Write Strategy

**Decision**: Atomic write (temp file + `fs.rename`)

**Rationale**:
- Prevents corruption on crash/power loss
- Established pattern in codebase (credhelper file-store, launch scaffolder)
- `config.yaml` is small (<1KB), no streaming needed

**Implementation Pattern**:
```typescript
const tmpPath = `${configPath}.tmp.${process.pid}`;
await fs.writeFile(tmpPath, content, { mode: 0o644 });
await fs.rename(tmpPath, configPath);
```

### 5. Idempotency Check for Clone

**Decision**: Check directory existence at `/workspaces/<repo-name>`

**Rationale**:
- Simple `fs.access()` or `fs.stat()` check
- If directory exists, skip clone and emit `done` immediately
- No need for git-specific checks (partial clones would require `git status`)
- Matches spec requirement: "existing repos at the target path skip cloning"

**Edge Case**: If directory exists but is corrupt/partial, user must manually delete and retry. Acceptable for v1.5.

## Implementation Patterns

### Module-Level Push Event (existing pattern)

```typescript
// In audit.ts (existing):
let pushEventFn: ((channel: string, data: unknown) => void) | undefined;
export function setRelayPushEvent(fn: typeof pushEventFn): void {
  pushEventFn = fn;
}

// In peer-repo-cloner.ts (new - imports from audit.ts):
import { setRelayPushEvent } from '../routes/audit.js';
// Or: expose a shared getter that both audit and clone services use
```

**Consideration**: The `pushEventFn` is currently scoped to `audit.ts`. Two options:
1. Export a `getRelayPushEvent()` getter from `audit.ts`
2. Move `setRelayPushEvent`/`getRelayPushEvent` to a shared module (e.g., `src/relay-events.ts`)

**Recommendation**: Option 2 — extract to `src/relay-events.ts` for cleaner separation. Both audit and clone services import from there.

### Repo Name Extraction from URL

GitHub repo URLs come in format: `https://github.com/owner/repo-name.git` or `https://github.com/owner/repo-name`

```typescript
function extractRepoName(repoUrl: string): string {
  const parts = repoUrl.replace(/\.git$/, '').split('/');
  return parts[parts.length - 1];
}
```

### Token-Authenticated Clone URL

```typescript
function buildCloneUrl(repo: string, token?: string): string {
  if (!token) return repo;
  const url = new URL(repo);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}
```

## Key Sources

- Existing `setRelayPushEvent` in `packages/control-plane/src/routes/audit.ts`
- `CodeServerProcessManager` spawn pattern in `src/services/code-server-manager.ts`
- Atomic write pattern from `packages/credhelper-daemon/src/backends/file-store.ts`
- Cloud lifecycle actions from `services/api/src/routes/clusters/lifecycle.ts` (5 actions)
- GitHub App installation token pattern: `https://x-access-token:<token>@github.com/owner/repo.git`
