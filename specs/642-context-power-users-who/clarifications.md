# Clarifications: `generacy registry-login` subcommand

## Batch 1 — 2026-05-16

### Q1: DOCKER_CONFIG host-side mechanism
**Context**: FR-008 says "Sets `DOCKER_CONFIG` env var in generated docker-compose to point at scoped config." However, `docker compose pull` runs on the **host**, and compose `environment:` keys only affect container processes — they don't influence the host Docker daemon's credential lookup.
**Question**: Should the CLI instead set `DOCKER_CONFIG=<projectDir>/.docker` as a process environment variable when invoking `docker compose` commands (in `up`, `update`, `pull`), rather than writing it into the compose file's `environment:` block?
**Options**:
- A: CLI sets `DOCKER_CONFIG` as a process env var on every `docker compose` invocation (in `compose.ts` helper)
- B: Write `DOCKER_CONFIG` into a `.env` file that the compose helper sources
- C: Both — process env for immediate use + `.env` for other tools

**Answer**: **A** — CLI sets `DOCKER_CONFIG` as a process env var when spawning `docker compose`. The `compose.ts` helper checks for `<projectDir>/.generacy/.docker/config.json` existence and sets `DOCKER_CONFIG=<projectDir>/.generacy/.docker` in the spawn env when present. No `.env` file involvement.

### Q2: CLI-to-control-plane transport
**Context**: The spec says "forwards credential to control-plane if cluster is running" via `PUT /credentials/registry-<host>`. But the control-plane listens on a Unix socket **inside** the container (`/run/generacy-control-plane/control.sock`), and the CLI runs on the host. Existing CLI commands (like `claude-login`) use `docker compose exec` to run commands inside the container.
**Question**: How should the CLI reach the control-plane to forward credentials? Via `docker compose exec` invoking a curl/helper inside the container, via a forwarded port, or via the cloud relay?
**Options**:
- A: `docker compose exec orchestrator curl --unix-socket /run/generacy-control-plane/control.sock ...` (follows `claude-login` pattern)
- B: Add a published port to the control-plane socket and HTTP directly from host
- C: Use the cloud relay (requires cloud auth, adds latency)

**Answer**: **A** — `docker compose exec orchestrator curl --unix-socket ...`. Established pattern from `claude-login`. No new port exposure (security), no cloud round-trip (works offline), reuses existing container-shell access path.

### Q3: Credhelper credential type
**Context**: The credhelper-daemon has 9 core plugins (`github-app`, `github-pat`, `gcp-service-account`, `aws-sts`, `stripe-restricted-key`, `api-key`, `env-passthrough`, `credential-file`, and one more), but none for Docker/container registry credentials. The `PutCredentialBodySchema` accepts generic `{type, value}` — but without a matching plugin, the credhelper can't render the credential into a session environment.
**Question**: Should this PR add a new `docker-registry` credential plugin to `credhelper-daemon/src/plugins/core/`, or should registry credentials be stored with an existing generic type (e.g., `env-passthrough`)?
**Options**:
- A: Add new `docker-registry` plugin (sets `DOCKER_CONFIG` or injects auth into Docker daemon config within the session)
- B: Use `env-passthrough` type (stores as env var, simpler but no Docker-specific session wiring)
- C: Store credential in control-plane only (no credhelper plugin needed — just persists for `generacy update` to read back)

**Answer**: **C** — Store with type discriminator `docker-registry` in the control-plane (credhelper backend) without adding a credhelper plugin in v1.6. The `PutCredentialBodySchema` accepts arbitrary string types; the plugin registry is only consulted when rendering session exposures, which docker registry credentials don't need — docker pull is host-bound, not session-bound. Adding a plugin is a tracked follow-up for v1.7.

### Q4: Credential value format for forwarding
**Context**: The scoped Docker config stores `base64(username:token)` per the Docker config format. When forwarding to the control-plane via `PUT /credentials/registry-<host>`, the `value` field is a plain string. The spec doesn't specify what format this string should take.
**Question**: What should the credential `value` contain when forwarded to the control-plane?
**Options**:
- A: The raw base64 string (same as Docker's `auth` field) — consumer must know to decode
- B: A JSON object like `{"username":"...","token":"...","host":"..."}` — more explicit, follows `github-app` pattern
- C: The raw `username:token` string (pre-base64) — simplest for re-encoding

**Answer**: **B** — JSON with discrete fields: `{"username": "...", "password": "..."}`. Consistent format across sibling issues. Host derived from credentialId.

### Q5: Compose pull credential flow on `generacy update`
**Context**: `generacy update` runs `docker compose pull` + `up -d`. After `registry-login`, the scoped config exists on the host. But if the user runs `generacy update` from a different terminal session, `DOCKER_CONFIG` may not be set (unless it's in `.env` or always injected by the CLI).
**Question**: Should `generacy update` (and `generacy up`) automatically detect and use the scoped Docker config at `<projectDir>/.docker/config.json` if it exists, even without a prior `registry-login` in the same session?
**Options**:
- A: Yes — all compose-invoking commands check for `<projectDir>/.docker/` and set `DOCKER_CONFIG` automatically
- B: No — user must run `registry-login` once per terminal session, or set `DOCKER_CONFIG` manually
- C: Yes, but only if `.docker/config.json` exists (auto-detect, no env var persistence needed)

**Answer**: **A** — Compose-invoking commands automatically detect `<projectDir>/.generacy/.docker/config.json` and set `DOCKER_CONFIG` when it exists. Centralized in the `compose.ts` spawn helper so every command path (`up`, `update`, `pull`, etc.) gets it consistently. No env var persistence between invocations needed.
