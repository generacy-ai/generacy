# Research: fd-based advisory lock for cluster-local backend

**Feature**: #521 | **Date**: 2026-05-01

## Technology Decision: `FileHandle.lock()` vs alternatives

### Chosen: Node.js built-in `FileHandle.lock(exclusive)` (Node >=22)

Node.js 22+ exposes `FileHandle.lock(exclusive?: boolean)` and `FileHandle.unlock()`, which map directly to POSIX `flock(2)` on Linux.

**API**:
```ts
const fh = await fs.open(lockPath, 'w');
await fh.lock(true);   // LOCK_EX — blocks until acquired
// ... critical section ...
await fh.close();       // automatically releases lock
```

**Properties**:
- **Blocking**: `fh.lock()` blocks the calling thread in libuv's thread pool until the lock is available. No busy-wait/spin.
- **Crash-safe**: If the process crashes, the OS closes all fds, which releases all advisory locks. No stale lock files.
- **Re-entrant within process**: `flock(2)` is per-fd, not per-process. Two `open()` calls in the same process get independent locks. This means `withLock()` correctly serializes even within one process.
- **No `unlock()` needed**: Closing the file handle releases the lock. Using `fh.close()` in a `finally` block is the simplest and safest pattern.

### Rejected: `proper-lockfile` npm package

- Adds a runtime dependency (violates FR-002 / US2)
- Uses lockfile-existence strategy which requires stale-lock cleanup
- More complex failure modes (stale detection, polling intervals)

### Rejected: Locking the data file directly

- The atomic write pattern uses `rename()` to replace the data file
- `flock()` locks are tied to the inode, not the path
- After `rename()`, a new `open()` on the same path would get a different inode
- Using a separate lock file avoids this inode-swap problem entirely

### Rejected: `fh.unlock()` explicit unlock

- `fh.close()` releases the lock as a side effect
- Using both `unlock()` and `close()` adds unnecessary complexity
- If `unlock()` fails, the `close()` in `finally` would still release it
- Simpler to just `close()` the handle

## Lock File Strategy

**Path**: `${dataPath}.lock` (e.g., `/var/lib/generacy/credentials.dat.lock`)

The lock file is:
- Created on first use (mode defaults from `fs.open('w')`)
- Never deleted — it's just a signaling mechanism
- Zero bytes — never written to
- Safe to leave on disk — advisory locks are fd-based, not file-existence-based

## Node.js Version Compatibility

- `FileHandle.lock()` was added in Node.js 22.0.0
- The project already requires Node >=22 (CLI version gate in `packages/generacy/src/cli/utils/node-version.ts`)
- `package.json` engines field says `>=20.0.0` — this is the daemon package which runs inside the container (Node 22 base image), not the CLI

## Implementation Pattern

```ts
private async withLock<T>(fn: () => Promise<T>): Promise<T> {
  const fh = await fs.open(this.lockPath, 'w');
  try {
    await fh.lock(true);
    return await fn();
  } finally {
    await fh.close();
  }
}
```

This is the minimal, correct implementation:
1. Open lock file (creates if missing)
2. Acquire exclusive lock (blocks until available)
3. Run the critical section
4. Close the handle (releases lock) in `finally`

## Sources

- Node.js docs: `FileHandle.lock()` — https://nodejs.org/api/fs.html#filehandlelockexclusive
- POSIX `flock(2)` man page — advisory locking semantics
- #491 original cluster-local backend implementation
- #491-Q5 clarification: fd-based lock chosen over `proper-lockfile`
