# Bug Fix: Boot-render uploaded file blobs on container recreate

**Branch**: `637-summary-when-user-uploads` | **Date**: 2026-05-16 | **Status**: Draft

## Summary

When a user uploads an app-config file (e.g. a GCP service account JSON) via the bootstrap wizard / Settings panel, the control-plane daemon encrypts and stores the blob persistently in `ClusterLocalBackend` under `backendKey = "app-config/file/${id}"` (backed by `/var/lib/generacy/credentials.dat` on the `generacy-data` named volume) and atomically writes it to the manifest's declared `mountPath`.

The encrypted blob survives `docker compose down && up`, but the file at `mountPath` does not — it lands on the container's writable overlay layer and is wiped on container recreate.

`AppConfigSecretEnvStore` already handles the equivalent case for env vars by re-rendering `secrets.env` at boot from the encrypted backend (#632). The parallel for files was never implemented.

## User Stories

### US1: Uploaded files survive container recreation

**As a** cluster operator,
**I want** uploaded app-config files (e.g. GCP SA JSON) to be automatically restored to their `mountPath` when the container restarts,
**So that** `docker compose down && up` doesn't silently break services that depend on those files.

**Acceptance Criteria**:
- [ ] After `docker compose down && up`, previously uploaded files appear at their declared `mountPath` without UI action
- [ ] File content is byte-identical to the original upload
- [ ] Structured log line `{ event: "files-rendered", count: N, skipped: M }` emitted at boot

### US2: Graceful degradation on edge cases

**As a** cluster operator,
**I want** the boot-render to skip problematic files with warnings rather than crashing,
**So that** one bad file doesn't prevent the entire daemon from starting.

**Acceptance Criteria**:
- [ ] Denylisted `mountPath` skipped with warning log
- [ ] Missing blob in backend (orphaned metadata) skipped with warning log
- [ ] Unwritable `mountPath` (EACCES) skipped with warning log, surfaced in init result
- [ ] Orphaned blob (id not in current manifest) skipped with warning log

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `AppConfigFileStore` gains `renderAll(backend, manifest)` method that re-materializes all stored files at boot | P1 | Called from `bin/control-plane.ts` after `init()` |
| FR-002 | `renderAll()` reads `values.yaml` to enumerate stored file ids | P1 | Same metadata source as `getAll()` |
| FR-003 | For each file id, fetch base64 blob via `backend.fetchSecret(\`app-config/file/${id}\`)` | P1 | |
| FR-004 | Look up each file's `mountPath` from the *current* manifest (not the path stored at upload time) | P1 | Manifest may have changed since upload |
| FR-005 | Validate `mountPath` against existing `isPathDenied()` denylist | P1 | Same fail-closed check as PUT path |
| FR-006 | Atomically write blob to `mountPath` (temp+rename, mode `0640`, `node:node`) | P1 | Extract shared helper if `setFile()` duplicates logic |
| FR-007 | Emit structured log `{ event: "files-rendered", count, skipped }` | P2 | Matches #624 `initResult` pattern |
| FR-008 | Surface file-render status in init result (same pattern as #624 store status) | P2 | |

## Edge Cases

- **Manifest changed since upload**: Boot render uses the *current* manifest's `mountPath`. Old path is not cleaned up (documented trade-off).
- **mountPath denylisted**: Skip file, log warning. Same fail-closed behavior as PUT path.
- **mountPath unwritable (EACCES)**: Skip with warning, surface via init result, don't crash. Same resilience as #624.
- **Blob missing from backend**: Metadata-only orphan. Log warning, skip, surface in init result.
- **File id not in manifest**: Orphaned blob. Log warning, skip.

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Files restored after restart | 100% of files with valid manifest entries | Manual test: upload file, restart, verify presence |
| SC-002 | No daemon crash on edge cases | 0 crashes | Unit tests for each edge case |
| SC-003 | Structured boot log emitted | Always | Grep for `files-rendered` in logs |

## Test Plan

- [ ] Unit: `AppConfigFileStore` boot-render walks `values.yaml.files`, decrypts each, writes to `mountPath`
- [ ] Unit: denylisted `mountPath` in manifest causes that file to be skipped with structured warning; others still render
- [ ] Unit: missing blob in backend (metadata-only entry) skipped + warning, no crash
- [ ] Integration: with one file uploaded, restart daemon; file appears at `mountPath` without UI action
- [ ] Manual: upload SA JSON, `docker compose down && up`, file present at `mountPath`, byte-identical
- [ ] Manual: edit manifest to change file's `mountPath`, restart; blob renders at new path (old path left as-is)

## Assumptions

- `AppConfigSecretEnvStore` boot-render (#632) is already merged and working — this follows the identical pattern for files
- `ClusterLocalBackend` and `values.yaml` metadata are the source of truth for stored file blobs
- The `isPathDenied()` denylist and atomic write pattern from the PUT path are correct and reusable

## Out of Scope

- Cleaning up orphaned blobs (follow-up)
- Cleaning up old `mountPath` when manifest changes (documented trade-off)
- Worker container file rendering (orchestrator-only for now)

## Related

- #622 — original feature; specified "files persistent, materialized at boot AND on PUT" but only the PUT half landed
- #632 — secrets boot-render; same pattern, applied to env vars. This issue is the parallel for files
- cluster-base#38 — entrypoint sources env files; file mountPaths are independent
- #624 — control-plane daemon crash resilience; init result / store status pattern reused here

---

*Generated by speckit*
