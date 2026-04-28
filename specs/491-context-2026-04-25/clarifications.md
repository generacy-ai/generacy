# Clarifications — #491 Cluster-Local Credhelper Backend

## Batch 1 — 2026-04-28

### Q1: Interface Extension for Set/Delete
**Context**: The current `BackendClient` interface (in `@generacy-ai/credhelper`) only defines `fetchSecret(key): Promise<string>`. FR-009 requires set and delete operations, and US3 lists "Backend supports set and delete operations for credential lifecycle" as acceptance criteria. The spec assumption notes this is undecided.
**Question**: Should `setSecret(key, value)` and `deleteSecret(key)` be added to the shared `BackendClient` interface in `packages/credhelper`, or should they be internal methods on `ClusterLocalBackend` only (not part of the shared contract)?
**Options**:
- A: Extend the shared `BackendClient` interface with `setSecret` and `deleteSecret` (breaking change for all implementations)
- B: Keep `BackendClient` read-only; add a separate `WritableBackendClient` interface that `ClusterLocalBackend` implements
- C: Internal methods on `ClusterLocalBackend` only, not exposed via any shared interface

**Answer**: *Pending*

### Q2: Default Backend Wiring
**Context**: The factory receives a `BackendEntry` object with a `type` field. FR-008 says "Make cluster-local the default when config omits an explicit backend type." But the current `BackendEntry` schema requires a `type: z.string()` field. It's unclear where the defaulting happens.
**Question**: Where should the "default to cluster-local" logic live — in the config loader (injecting `type: 'cluster-local'` when backend is omitted), or in the factory (treating an undefined/empty type as cluster-local)?
**Options**:
- A: Config loader fills in `type: 'cluster-local'` as a default before passing to factory
- B: Factory treats missing/empty type as `cluster-local`

**Answer**: *Pending*

### Q3: Set/Delete Callers
**Context**: The spec mentions set/delete operations but doesn't specify which component calls them. The control-plane has stub routes `GET/PUT /credentials/:id` (#490). The session manager currently only calls `fetchSecret`.
**Question**: Who invokes set/delete on the cluster-local backend in v1.5? Is it the control-plane routes (via the bootstrap UI), the session manager, or both?
**Options**:
- A: Control-plane routes only (bootstrap UI writes credentials, session manager reads)
- B: Session manager manages lifecycle (set on session begin, delete on session end)
- C: Both (control-plane for initial storage, session manager for lifecycle)

**Answer**: *Pending*

### Q4: Corrupt File Recovery
**Context**: The spec defines atomic writes via temp-file-and-rename to prevent corruption, but doesn't address what happens if `credentials.dat` already exists and contains invalid JSON or an unrecognized version number.
**Question**: What should the backend do when `credentials.dat` is present but unreadable (corrupt JSON, wrong version, or decryption failure on all entries)?
**Options**:
- A: Fail closed — throw an error, refuse to start (operator must manually intervene)
- B: Log a warning and start fresh with an empty store (existing credentials are lost)
- C: Fail closed for corrupt JSON; for unknown version, throw a specific "migration needed" error

**Answer**: *Pending*

### Q5: File Locking Strategy
**Context**: The spec mentions "single-process write lock via file mutex (e.g., proper-lockfile or fd-based advisory lock)" but doesn't mandate which approach. `proper-lockfile` is a third-party npm package; fd-based advisory lock uses OS `flock()` via Node.js `fs` handles.
**Question**: Should the implementation use an npm package like `proper-lockfile` or implement fd-based advisory locking with Node.js built-in `fs` APIs (consistent with the daemon's zero-external-deps-where-possible pattern)?
**Options**:
- A: Use `proper-lockfile` npm package (battle-tested, handles stale locks)
- B: Implement fd-based advisory lock with Node.js built-in `fs` (no new dependency, matches daemon pattern)

**Answer**: *Pending*
