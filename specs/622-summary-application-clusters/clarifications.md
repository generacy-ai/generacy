# Clarifications for #622

## Batch 1 — 2026-05-15

### Q1: File exposure path allowlist vs motivating example
**Context**: The spec states the file exposure path "must be inside an explicit allowlist root (e.g. `/var/lib/generacy-app-config/files/`)" but the motivating example declares `mountPath: "/home/node/.config/gcloud/secrets/sa.json"`, which is outside that root. The implementation needs to know the actual allowlist mechanism to validate paths correctly.
**Question**: How should variant-specific allowlist roots be configured? Should `/home/node/.config/` be a hardcoded additional root for `cluster-microservices`, read from an env var, or should the `mountPath` in the manifest implicitly whitelist the path?
**Options**:
- A: Hardcode a small set of known roots per variant (e.g. `cluster-base` allows `/var/lib/generacy-app-config/files/`, `cluster-microservices` also allows `/home/node/.config/`)
- B: Read additional allowed roots from an env var (e.g. `GENERACY_FILE_EXPOSURE_ROOTS`)
- C: The manifest's `mountPath` itself is the authorization — any path declared in `appConfig.files` is allowed

**Answer**: *Pending*

### Q2: File persistence vs credhelper session lifecycle
**Context**: The spec says "files are wiped on session end" (credhelper session = one agent workflow run). But compose services need stable file paths that survive individual workflow sessions. If a GCP SA JSON is deleted when a Claude session ends, the running voice agent service would break. This is an architectural decision that fundamentally affects whether files are written through credhelper sessions or directly by the control-plane.
**Question**: Should `POST /control-plane/app-config/files/:id` write the file directly to `mountPath` (persistent, independent of credhelper sessions), or store it through a credhelper session that gets cleaned up? If persistent, should session-start merely verify the file exists rather than re-create it?
**Options**:
- A: Control-plane writes files directly to `mountPath` (persistent until explicitly deleted or cluster destroyed). Credhelper `file` exposure is only used for session-scoped use cases (future).
- B: Control-plane stores the blob in credhelper backend; a startup routine materializes all stored files to their `mountPath` on boot/session-start. Files survive sessions because they're re-materialized.
- C: Two modes — `appConfig.files` are persistent (written directly), credhelper `file` exposure is session-scoped (for roles).

**Answer**: *Pending*

### Q3: Non-secret env file format and write semantics
**Context**: The spec references `/var/lib/generacy-app-config/env` as the materialized env file sourced by the cluster entrypoint. The implementation needs to know the exact format and update strategy since multiple `PUT` calls can happen concurrently and the file must be parseable by `source` in bash.
**Question**: What format should the plain env file use (`KEY=VALUE` or `export KEY=VALUE`?), should values be quoted (e.g. `KEY="value with spaces"`), and should each `PUT` do a full rewrite of the file (read-modify-write with advisory lock) or append?
**Options**:
- A: `KEY=VALUE` with double-quoted values, full atomic rewrite (read all → update entry → temp+rename) with fd-based advisory lock
- B: `export KEY="VALUE"` with atomic rewrite (same mechanism as `CredentialFileStore`)
- C: Simple `KEY=VALUE` unquoted, append-only (risk of duplicates; last value wins with bash `source`)

**Answer**: *Pending*

### Q4: Files endpoint permissiveness for undeclared IDs
**Context**: The spec explicitly marks `PUT /control-plane/app-config/env` as permissive (accepts names not in the manifest). For files, the `mountPath` comes from the manifest — if a file ID isn't declared in `appConfig.files`, there's no `mountPath` to write to. This affects API design and error handling.
**Question**: Should `POST /control-plane/app-config/files/:id` reject file IDs not declared in the manifest (since there's no `mountPath`), or should it accept an optional `mountPath` in the request body as a fallback for undeclared files?
**Options**:
- A: Strict — reject undeclared file IDs with 400 (manifest is the source of truth for files)
- B: Permissive — accept optional `mountPath` in request body; required when ID is not in manifest
- C: Permissive — store the blob but don't materialize it (no path); cloud UI can assign a path later

**Answer**: *Pending*

### Q5: CLI transport to control-plane
**Context**: `npx generacy app-config show/set` runs on the host machine. The control-plane's Unix socket (`/run/generacy-control-plane/control.sock`) is only reachable inside the container. The CLI needs a transport mechanism to reach it. Existing CLI commands use different approaches: `claude-login` uses `docker compose exec`, while `open` goes through the cloud.
**Question**: Should the CLI `app-config` commands reach the control-plane via `docker compose exec` (run a curl/helper inside the container), via the cloud relay (HTTP through WebSocket), or via Docker API socket forwarding?
**Options**:
- A: `docker compose exec orchestrator curl --unix-socket ...` — simple, no new infra, matches `claude-login` pattern
- B: Route through cloud relay (`PUT /control-plane/app-config/env` via cloud → relay → control-plane socket) — works for remote deploys too
- C: Direct HTTP to orchestrator's Fastify port (if exposed) which proxies to control-plane socket

**Answer**: *Pending*
