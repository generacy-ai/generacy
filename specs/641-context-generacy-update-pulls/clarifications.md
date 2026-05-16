# Clarifications

## Batch 1 — 2026-05-16

### Q1: Secret Value Retrieval Endpoint
**Context**: The existing `GET /credentials/:id` on the control-plane socket returns only metadata (`{ id, type, backend, status, updatedAt }`), NOT the actual decrypted secret value. The spec assumes the CLI can fetch the credential value via this endpoint. Implementation is blocked without a way to read the secret.
**Question**: Should this issue add a new control-plane endpoint (e.g., `GET /credentials/:id/value`) that decrypts via `ClusterLocalBackend.fetchSecret()` and returns the raw secret? Or should we modify the existing GET endpoint to include the value?
**Options**:
- A: New endpoint `GET /credentials/:id/value` (keeps existing metadata endpoint unchanged)
- B: Extend existing `GET /credentials/:id` with a `?include=value` query param
- C: Different approach (describe)

**Answer**: *Pending*

### Q2: Credential Value Shape
**Context**: The spec assumes "Docker auth JSON (base64-encoded user:pass in auth field)" but doesn't specify the exact structure stored. When we write the scoped `config.json`, we need to know whether the stored value is the full Docker config structure or just the inner auth entry.
**Question**: What format is a `registry-<host>` credential value stored in?
**Options**:
- A: Full Docker config JSON: `{"auths":{"<host>":{"auth":"base64(user:pass)"}}}`
- B: Just the inner auth object: `{"auth":"base64(user:pass)"}`
- C: Raw base64-encoded `user:pass` string (CLI wraps it into Docker config format)
- D: JSON with discrete fields: `{"username":"...","password":"..."}`

**Answer**: *Pending*

### Q3: Sibling Helper Availability
**Context**: The spec references a shared `materializeScopedDockerConfig()` helper from the sibling issue "Pull cluster image with scoped private-registry credentials". This helper does not exist in the codebase yet. The spec says both issues share it, but doesn't specify which implements it first.
**Question**: Should this issue (#641) implement `materializeScopedDockerConfig()` (and the sibling reuses it), or is the sibling expected to land first providing it?
**Options**:
- A: This issue implements the helper (sibling depends on us)
- B: Sibling implements it first (we depend on sibling)
- C: Either can implement it — just pick one and share

**Answer**: *Pending*

### Q4: Scoped Config Path and Crash Safety
**Context**: The spec places the scoped config at `<projectDir>/.docker/config.json`. This directory sits at the project root where it could be accidentally committed if the process crashes before cleanup. The `try/finally` pattern handles normal exits but not SIGKILL or power loss.
**Question**: Should the scoped Docker config be written to the project root (`.docker/`) as specified, or to a safer location like a temp directory (`os.tmpdir()`) or under `.generacy/.docker/`? If project root, should we add `.docker/` to `.gitignore` scaffolding as a safety net?
**Options**:
- A: Project root `.docker/` as specified (no additional safety)
- B: Project root `.docker/` + add to `.gitignore` in scaffolder
- C: Under `.generacy/.docker/` (already gitignored by convention)
- D: System temp directory (fully isolated from project)

**Answer**: *Pending*
