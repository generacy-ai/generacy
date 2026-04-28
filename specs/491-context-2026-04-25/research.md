# Research: Cluster-Local Credhelper Backend

**Feature**: #491 | **Date**: 2026-04-28

## Technology Decisions

### 1. Encryption: AES-256-GCM via `node:crypto`

**Decision**: Use Node.js built-in `crypto.createCipheriv('aes-256-gcm', ...)` with random 12-byte IVs.

**Rationale**:
- AES-256-GCM is an authenticated encryption with associated data (AEAD) cipher — provides both confidentiality and integrity
- 12-byte IV is the recommended size for GCM (NIST SP 800-38D)
- Per-credential random IV prevents identical plaintexts from producing identical ciphertexts
- Auth tag (16 bytes) detects tampering without needing a separate HMAC step
- Zero external dependencies — `node:crypto` is built-in and uses OpenSSL under the hood

**Alternatives Considered**:
- `libsodium-wrappers`: Better ergonomics (sealed boxes) but adds an npm dependency with native bindings. Overkill for a single-file store.
- `tweetnacl`: Pure JS, but XSalsa20-Poly1305 is less standard in enterprise contexts. Also an external dep.
- AES-256-CBC + HMAC: Two-step construct, more error-prone (encrypt-then-MAC ordering matters). GCM does both in one pass.

### 2. File Locking: fd-based Advisory Lock

**Decision**: Use `fs.open()` + `flock()` via Node.js for advisory file locking.

**Rationale**:
- Single daemon process per cluster — advisory locks are sufficient (no mandatory lock needed)
- Node.js 20+ supports `filehandle.lock()` / `filehandle.unlock()` (wraps POSIX `flock`)
- No npm dependency needed (unlike `proper-lockfile` which uses polling + stale detection)
- Lock scope: exclusive lock held only during write operations; reads use in-memory cache

**Implementation**:
```typescript
const fh = await fs.open(lockPath, 'w');
await fh.lock('exclusive');  // blocks until acquired
try {
  await fn();
} finally {
  await fh.unlock();
  await fh.close();
}
```

**Alternatives Considered**:
- `proper-lockfile`: Handles stale locks, cross-platform. But adds a dep and its stale-lock recovery isn't needed (single process).
- `flock` via native addon: Unnecessary complexity when Node.js exposes it directly.
- No locking: Risky even in single-process — async operations could interleave writes.

### 3. Atomic File Writes: temp + fsync + rename

**Decision**: Write to a temporary file in the same directory, `fsync` it, then `rename` over the target.

**Rationale**:
- `rename()` is atomic on POSIX when source and target are on the same filesystem
- `fsync` before rename ensures data is on disk (prevents zero-length files on crash)
- Same-directory temp file ensures same-filesystem guarantee
- Pattern is well-established (SQLite WAL, systemd, etc.)

**Implementation**:
```typescript
const tmpPath = `${dataPath}.tmp.${process.pid}`;
await fs.writeFile(tmpPath, data, { mode: 0o600 });
const fh = await fs.open(tmpPath, 'r');
await fh.datasync();
await fh.close();
await fs.rename(tmpPath, dataPath);
```

### 4. File Format: JSON Envelope

**Decision**: Simple JSON file with version field and entries map.

```json
{
  "version": 1,
  "entries": {
    "credential-key": {
      "ciphertext": "<base64>",
      "iv": "<base64>",
      "authTag": "<base64>"
    }
  }
}
```

**Rationale**:
- Human-debuggable structure (even though values are encrypted)
- Version field enables forward-compatible migrations
- Flat key-value map matches the `fetchSecret(key)` / `setSecret(key, value)` API
- Small credential count expected (tens, not thousands) — JSON parsing overhead negligible

**Alternatives Considered**:
- SQLite: Overkill for a small key-value store; adds native dep.
- Binary format (MessagePack, Protocol Buffers): Not human-debuggable; version management harder.
- Multiple files per credential: Harder to atomically update multiple credentials; directory enumeration for listing.

### 5. Master Key Management

**Decision**: Random 32-byte key file at `/var/lib/generacy/master.key`, mode 0600, created on first boot.

**Rationale**:
- Simple and auditable — `ls -la` shows permissions
- Persistent named volume keeps key across container restarts
- Separate from credential data file — can be independently backed up or excluded
- No key derivation function needed (key is random, not password-derived)

**Recovery model**: Destroy and re-enter. If master key is lost, credentials file is unrecoverable. Operator must delete both files and re-enter credentials via the bootstrap UI. Key rotation deferred to post-v1.5.

### 6. In-Memory Caching Strategy

**Decision**: Load entire credential store into memory on init; update cache on write operations.

**Rationale**:
- Single-process assumption means no external cache invalidation needed
- Credential count is small (tens of entries) — fits easily in memory
- Avoids disk I/O on every `fetchSecret` call (hot path during session begin)
- Cache is authoritative — writes update both disk and cache atomically (under lock)

### 7. Error Codes

| Error Code | HTTP Status | Condition |
|-----------|-------------|-----------|
| `CREDENTIAL_STORE_CORRUPT` | 500 | Invalid JSON in credentials.dat |
| `CREDENTIAL_STORE_MIGRATION_NEEDED` | 500 | Unknown version number in credentials.dat |
| `BACKEND_SECRET_NOT_FOUND` | 502 | Key not found in credential store |
| `BACKEND_UNREACHABLE` | 502 | Master key file unreadable or permission denied |

These integrate with the existing `CredhelperError` class and HTTP status mapping in `credhelper-daemon/src/errors.ts`.

## Key Sources

- NIST SP 800-38D: Recommendation for GCM Mode (AES-GCM IV and tag requirements)
- Node.js `node:crypto` docs: `createCipheriv`, `createDecipheriv` with `aes-256-gcm`
- Node.js `node:fs/promises` docs: `FileHandle.lock()`, `FileHandle.datasync()`
- Existing codebase: `packages/credhelper-daemon/src/backends/env-backend.ts` (pattern reference)
- Architecture doc: `docs/credentials-architecture-plan.md` (locked decision #1)
