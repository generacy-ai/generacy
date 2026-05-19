# Research: App-Config Secrets Env Renderer

## Technology Decisions

### 1. Store Class vs. Inline Logic

**Decision**: New `AppConfigSecretEnvStore` class mirroring `AppConfigEnvStore`.

**Rationale**: The existing `AppConfigEnvStore` is ~120 LOC with well-tested patterns (fallback chain, atomic writes, promise-chain mutex, `StoreStatus` reporting). Duplicating this structure for the secrets file gives us the same resilience guarantees with minimal cognitive overhead. The alternative — adding secret-rendering logic inline in the route handlers — would scatter file I/O and error handling across multiple locations.

**Alternatives considered**:
- **Extend AppConfigEnvStore to handle both files**: Rejected. The two files have different paths, permissions semantics (persistent vs tmpfs), and initialization lifecycles. Merging them increases coupling.
- **Render on-demand (no file, fetch from backend per request)**: Rejected. User services need stable env-file availability at process start, not an API to call.

### 2. File Location: `/run/` tmpfs vs `/var/lib/` Persistent

**Decision**: `/run/generacy-app-config/secrets.env` (tmpfs) as preferred path.

**Rationale**: Plaintext secrets should not persist to disk. tmpfs is memory-only, wiped on container teardown. The encrypted backend (`credentials.dat`) remains the source of truth. The secrets file is a derived, ephemeral view.

**Fallback**: `/tmp/generacy-app-config/secrets.env` per #624 fallback-chain pattern. `/tmp` is often (but not always) tmpfs on Linux. WARN-level log emitted.

### 3. Bidirectional Secret-Flag Transition (Clarification Q1)

**Decision**: Automatic move on flag change, both directions.

**Rationale**: Rejecting transitions would accumulate stale state (old encrypted entry lingers). Requiring DELETE+PUT is bad UX for a UI toggle. The write-new-first, delete-old-second ordering ensures a concurrent reader always finds the value in at least one location.

### 4. Serialization: Promise-Chain vs fd-Based Lock

**Decision**: In-process promise-chain mutex (same as `AppConfigEnvStore`).

**Rationale**: The secrets.env file is written only by the control-plane daemon process. There's no cross-process writer. The promise chain is simpler and avoids the complexity of fd-based `flock` (which the `CredentialFileStore` uses because both credhelper-daemon and control-plane can write `credentials.dat`).

### 5. Boot-Time Render: All-or-Nothing vs Best-Effort

**Decision**: Best-effort partial render.

**Rationale**: Follows the `wizard-env-writer.ts` pattern. If 3 of 4 secrets unseal successfully, the user gets 3 of 4 env vars. Better than nothing. Failed entries logged as warnings and surfaced in `initResult`.

## Implementation Patterns

### Atomic File Write Pattern (reuse from AppConfigEnvStore)

```typescript
const tmpPath = `${this.envPath}.tmp.${process.pid}`;
const fd = await open(tmpPath, 'w', 0o640);
await fd.write(content);
await fd.datasync();
await fd.close();
await rename(tmpPath, this.envPath);
```

### Promise-Chain Mutex (reuse)

```typescript
private writeChain = Promise.resolve();

private async withLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = this.writeChain.then(fn, fn);
  this.writeChain = p.then(() => {}, () => {});
  return p;
}
```

### Fallback Init Pattern (reuse from #624)

```typescript
const PERM_ERRORS = new Set(['EACCES', 'EPERM', 'EROFS']);

async init(): Promise<void> {
  try {
    await mkdir(preferredDir, { recursive: true });
    this.envPath = preferredPath;
    this.status = 'ok';
  } catch (err) {
    if (PERM_ERRORS.has(err.code)) {
      try {
        await mkdir(fallbackDir, { recursive: true });
        this.envPath = fallbackPath;
        this.status = 'fallback';
      } catch {
        this.status = 'disabled';
      }
    }
  }
}
```

## Key Sources

- `packages/control-plane/src/services/app-config-env-store.ts` — primary pattern source
- `packages/control-plane/src/services/wizard-env-writer.ts` — unseal + partial-render pattern
- `packages/control-plane/src/types/init-result.ts` — StoreStatus types
- `packages/credhelper/src/backends/cluster-local-backend.ts` — fetchSecret() API
- `packages/control-plane/src/routes/app-config.ts` — route handlers to modify
- `packages/control-plane/bin/control-plane.ts` — initialization sequence
