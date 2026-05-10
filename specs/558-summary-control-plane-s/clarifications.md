# Clarifications — #558 Credential Persistence in Control-Plane

## Batch 1 (2026-05-10)

### Q1: Secret Write Mechanism
**Context**: The spec recommends option (a) — direct `ClusterLocalBackend` instantiation — but this class lives in `packages/credhelper-daemon` (not the shared `@generacy-ai/credhelper` types package). Control-plane currently depends only on `@generacy-ai/credhelper`. The package boundary prevents a direct import without architectural changes. Additionally, credhelper-daemon exposes no HTTP endpoint for writing secrets (`POST /sessions` and `DELETE /sessions/:id` only), so option (b) from the spec would require adding a new endpoint.
**Question**: How should control-plane access the `ClusterLocalBackend` to persist secret values?
**Options**:
- A: Add `@generacy-ai/credhelper-daemon` as a control-plane dependency (imports the full daemon package)
- B: Extract `ClusterLocalBackend` + crypto + file-store to the shared `@generacy-ai/credhelper` package (moves ~150 LOC)
- C: Re-implement the AES-256-GCM file I/O directly in control-plane (duplicated logic, divergence risk)
- D: Add a `PUT /secrets/:key` endpoint to credhelper-daemon and call it via HTTP from control-plane

**Answer**: **B** — Extract `ClusterLocalBackend` + `FileStore` + crypto helpers to the shared `@generacy-ai/credhelper` package (~250 LOC). Both daemon and control-plane import from the same source. Architecturally cleanest: single source of truth for storage logic, no dep coupling. *(via @christrudelpw on GitHub)*

---

### Q2: Cache Coherence with Credhelper-Daemon
**Context**: `ClusterLocalBackend` loads its entire credential store into an in-memory `Map` during `init()` and reads from cache on `fetchSecret()`. If control-plane writes credentials via a separate instance (or directly to the same file), the credhelper-daemon's running instance won't see new credentials until its cache is refreshed. This matters because credhelper-daemon creates agent sessions that resolve credentials via `fetchSecret()`.
**Question**: How is cache coherence maintained between control-plane writes and credhelper-daemon reads?
**Options**:
- A: Not an issue — credhelper-daemon is restarted after bootstrap completes (cache reloads on boot)
- B: Not an issue — agent sessions are never created until all bootstrap credentials are persisted (sequential boot guarantee)
- C: Need a reload mechanism (file watcher, reload endpoint, or re-read from disk at session-begin)
- D: Moot if Q1 answer is D (HTTP to daemon updates its in-process cache directly)

**Answer**: **A** — Restart credhelper-daemon on bootstrap-complete. Daemon supervisor stops the daemon, it comes back up, `init()` reloads cache from disk with populated credentials. Bootstrap-complete signal is already a defined event. Follow-up: file issue for cache-reload-on-write mechanism for post-bootstrap credential edits. *(via @christrudelpw on GitHub)*

---

### Q3: Partial Write Failure Strategy
**Context**: The handler performs two sequential writes: (1) secret value to encrypted file store, (2) metadata to `.agency/credentials.yaml`. If write 1 succeeds but write 2 fails (e.g., disk full, YAML parse error), we have an orphaned encrypted secret with no metadata entry pointing to it. The spec requires idempotency (FR-006), so a retry would overwrite cleanly — but the intermediate state matters for error responses.
**Question**: What is the error recovery strategy for partial write failure?
**Options**:
- A: Fail forward — return 500, orphaned secret is harmless and retryable (next PUT overwrites)
- B: Best-effort rollback — attempt `deleteSecret()` if YAML write fails, return 500
- C: Write metadata first, then secret — metadata without backing secret is safer (GET returns metadata, fetchSecret returns 404 until retry)

**Answer**: **A** — Fail forward, return 500, orphaned encrypted secret is harmless (still encrypted, no readers, not advertised) and retryable per FR-006 idempotency. 500 response should identify which write step failed in body (`failedAt` field) so retries can diagnose. *(via @christrudelpw on GitHub)*
