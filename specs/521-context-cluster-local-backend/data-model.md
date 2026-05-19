# Data Model: fd-based advisory lock for cluster-local backend

**Feature**: #521 | **Date**: 2026-05-01

## Interface Changes

### `CredentialFileStore` class

**Before** (current):
```ts
class CredentialFileStore {
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataPath: string,
    private readonly keyPath: string,
  ) {}

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const prev = this.lockPromise;
    this.lockPromise = new Promise<void>(resolve => { release = resolve; });
    await prev;
    try { return await fn(); }
    finally { release!(); }
  }
}
```

**After** (proposed):
```ts
class CredentialFileStore {
  private readonly lockPath: string;

  constructor(
    private readonly dataPath: string,
    private readonly keyPath: string,
  ) {
    this.lockPath = `${dataPath}.lock`;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const fh = await fs.open(this.lockPath, 'w');
    try {
      await fh.lock(true);
      return await fn();
    } finally {
      await fh.close();
    }
  }
}
```

### Changes Summary

| Property/Method | Before | After | Change Type |
|-----------------|--------|-------|-------------|
| `lockPromise` | `Promise<void>` instance property | Removed | Deleted |
| `lockPath` | N/A | `readonly string` (derived from `dataPath`) | Added |
| `withLock()` | In-memory Promise chain | fd-based `flock(LOCK_EX)` via `FileHandle.lock()` | Modified |

### Public API

**No changes**. The `CredentialFileStore` public API (`ensureMasterKey()`, `load()`, `save()`) is unchanged. The lock mechanism is an internal implementation detail.

## File Artifacts

| Path | Purpose | Change |
|------|---------|--------|
| `/var/lib/generacy/credentials.dat` | Encrypted credential store | Unchanged |
| `/var/lib/generacy/credentials.dat.lock` | Advisory lock file (new) | Created on first write |
| `/var/lib/generacy/master.key` | Master encryption key | Unchanged |

## Validation Rules

No changes to validation. The `CredentialFileEnvelopeSchema` and `EncryptedEntrySchema` remain the same.
