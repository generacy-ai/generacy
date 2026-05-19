# Clarifications

## Batch 1 — 2026-05-16

### Q1: Secret Value Retrieval Endpoint
**Context**: The existing `GET /credentials/:id` on the control-plane socket returns only metadata (`{ id, type, backend, status, updatedAt }`), NOT the actual decrypted secret value. The spec assumes the CLI can fetch the credential value via this endpoint. Implementation is blocked without a way to read the secret.
**Question**: Should this issue add a new control-plane endpoint (e.g., `GET /credentials/:id/value`) that decrypts via `ClusterLocalBackend.fetchSecret()` and returns the raw secret? Or should we modify the existing GET endpoint to include the value?
**Options**:
- A: New endpoint `GET /credentials/:id/value` (keeps existing metadata endpoint unchanged)
- B: Extend existing `GET /credentials/:id` with a `?include=value` query param
- C: Different approach (describe)

**Answer**: **A** — New endpoint `GET /credentials/:id/value` on the control-plane, restricted to local-socket callers and audit-logged separately. Existing metadata endpoint stays unchanged. Docker registry credentials are uniquely host-bound (consumed by `docker compose pull` on the host), unlike other credential types rendered into session environments via credhelper plugins. A new endpoint makes the "raw value read" capability explicit and easy to audit. Implementation note: control-plane will need a new IPC path to credhelper-daemon (which holds the encrypted store via its uid-isolated process). The current `GET /credentials/:id` only reads YAML metadata directly; the value endpoint needs to call credhelper-daemon over its Unix socket and ask for the raw secret.

### Q2: Credential Value Shape
**Context**: The spec assumes "Docker auth JSON (base64-encoded user:pass in auth field)" but doesn't specify the exact structure stored. When we write the scoped `config.json`, we need to know whether the stored value is the full Docker config structure or just the inner auth entry.
**Question**: What format is a `registry-<host>` credential value stored in?
**Options**:
- A: Full Docker config JSON: `{"auths":{"<host>":{"auth":"base64(user:pass)"}}}`
- B: Just the inner auth object: `{"auth":"base64(user:pass)"}`
- C: Raw base64-encoded `user:pass` string (CLI wraps it into Docker config format)
- D: JSON with discrete fields: `{"username":"...","password":"..."}`

**Answer**: **D** — JSON with discrete fields: `{"username": "...", "password": "..."}`. Follows the existing `github-app` credential pattern. Host is derived from credentialId (`registry-<host>`), so it's not duplicated in the value. CLI builds the Docker config structure (`{"auths":{<host>:{"auth": base64(user:pass)}}}`) from these fields when materializing the scoped config. Most explicit; future-proof for additional fields (e.g., token expiration).

### Q3: Sibling Helper Availability
**Context**: The spec references a shared `materializeScopedDockerConfig()` helper from the sibling issue "Pull cluster image with scoped private-registry credentials". This helper does not exist in the codebase yet. The spec says both issues share it, but doesn't specify which implements it first.
**Question**: Should this issue (#641) implement `materializeScopedDockerConfig()` (and the sibling reuses it), or is the sibling expected to land first providing it?
**Options**:
- A: This issue implements the helper (sibling depends on us)
- B: Sibling implements it first (we depend on sibling)
- C: Either can implement it — just pick one and share

**Answer**: **B** — Sibling (#639, "Pull cluster image with scoped private-registry credentials") implements `materializeScopedDockerConfig()` first; this issue consumes it. The helper lives in a shared utility module (`packages/generacy/src/cli/utils/docker-config.ts` or similar). If sequencing flips and #641 lands first, this issue implements; #639 consumes. Coordinate so it lands once.

### Q4: Scoped Config Path and Crash Safety
**Context**: The spec places the scoped config at `<projectDir>/.docker/config.json`. This directory sits at the project root where it could be accidentally committed if the process crashes before cleanup. The `try/finally` pattern handles normal exits but not SIGKILL or power loss.
**Question**: Should the scoped Docker config be written to the project root (`.docker/`) as specified, or to a safer location like a temp directory (`os.tmpdir()`) or under `.generacy/.docker/`? If project root, should we add `.docker/` to `.gitignore` scaffolding as a safety net?
**Options**:
- A: Project root `.docker/` as specified (no additional safety)
- B: Project root `.docker/` + add to `.gitignore` in scaffolder
- C: Under `.generacy/.docker/` (already gitignored by convention)
- D: System temp directory (fully isolated from project)

**Answer**: **C** — Under `<projectDir>/.generacy/.docker/`. The `.generacy/` directory is already CLI-managed (cluster.yaml, cluster.json scaffolded there) and follows the existing gitignore convention; placing the scoped Docker config under it inherits the safety net and clarifies ownership. Project root `.docker/` could be confused with a user's manual Docker conventions; system temp directory loses project-scoping.
