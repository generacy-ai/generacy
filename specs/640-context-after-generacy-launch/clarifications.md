# Clarifications: Forward Registry Credentials to Credhelper After First Launch

## Batch 1 — 2026-05-16

### Q1: LaunchConfig registryCredentials Shape
**Context**: The spec says `LaunchConfig.registryCredentials` carries "sufficient info to derive the registry host," and FR-006 specifies the PUT body as `{ type: "registry", value: "<base64-encoded auth>" }`. The current `LaunchConfigSchema` has no `registryCredentials` field. The shape of this field determines both the CLI parsing logic and how the credential ID (`registry-<host>`) is derived.
**Question**: What is the expected shape of `LaunchConfig.registryCredentials`? Specifically, is it a single object `{ host: string; auth: string }` or an array for multiple registries? (The "Out of Scope" section says multi-registry is future, but the FR-001 wording says "PUT each credential" implying iteration.)
**Options**:
- A: Single object `{ host: string; auth: string }` — one registry per launch
- B: Array `Array<{ host: string; auth: string }>` — future-proof but only one entry expected now
- C: Flat fields `registryHost: string; registryAuth: string` on LaunchConfig directly

**Answer**: B** — array `Array<{ host: string; auth: string }>`, single entry for v1.6.

Future-proofs against multi-registry without cost. Single-object → array is a breaking JSON change later; extending an array is additive. Matches existing array-shaped LaunchConfig fields (`repos.dev`, `repos.clone`). v1.6 always populates with at most one entry; cluster-side handler iterates.

---

### Q2: Handshake Detection Timing
**Context**: The spec says "after the cluster reports a successful handshake." The current launch flow detects activation via log pattern matching in `streamLogsUntilActivation()` (looks for "Go to:" with a verification URL). However, this detects the *device-code prompt*, not necessarily that the control-plane is ready to accept PUT requests. The control-plane socket may not be available until after full bootstrap.
**Question**: What event should trigger the credential forward — the existing log-pattern activation detection, or should we add a control-plane readiness probe (polling the Unix socket via `docker compose exec`) before attempting the PUT?
**Options**:
- A: Use existing log-pattern detection (simpler, risk of control-plane not yet ready)
- B: Add a readiness probe loop after log detection (more reliable, small added complexity)

**Answer**: B** — add a control-plane readiness probe loop after log-pattern activation detection.

The "Go to:" log line signals device-code prompt readiness, not control-plane HTTP readiness — the control-plane socket may not yet be accepting PUTs. There's already a `control-plane-probe.ts` in orchestrator (`packages/orchestrator/src/services/control-plane-probe.ts`) establishing this pattern. Small added complexity, eliminates a race.

---

### Q3: Actor Identity Header for PUT Request
**Context**: The control-plane `PUT /credentials/:id` route requires an `x-generacy-actor-user-id` header (enforced by `requireActor()` middleware). The CLI is making this call via `docker compose exec ... curl`, running outside the relay's actor-injection flow. Without this header, the PUT will return 401/403.
**Question**: What value should the CLI pass as `x-generacy-actor-user-id` when forwarding credentials? Should it use a synthetic system actor (e.g., `system:cli-launch`), the user's cloud userId from the LaunchConfig, or should the control-plane route be modified to exempt this specific call?
**Options**:
- A: Pass a synthetic actor like `system:cli-launch`
- B: Use `LaunchConfig.clusterId` or another existing identity field
- C: Make the credential route optionally skip actor validation for local-socket callers

**Answer**: A** — synthetic actor `system:cli-launch`.

The CLI doesn't have a real user identity locally during bootstrap, and a synthetic system actor makes the audit log honest: this credential was pushed during cluster bootstrap by the CLI on behalf of the launch flow, not as an interactive user action. If finer-grained attribution is needed later, extend LaunchConfig with `userId` (from the claim doc — `cluster-launch-claims.ts` already has it) and pass that as the actor. For v1.6 the synthetic actor is sufficient and clearly distinguishable in audit queries.

---

### Q4: Scoped .docker/config.json Location
**Context**: The spec references `<projectDir>/.docker/config.json` as the scoped Docker config created by the sibling "pull with creds" issue. However, Docker's `--config` flag expects a *directory* (not a file path), and the standard Docker config file is `config.json` inside that directory. The sibling issue hasn't been implemented yet, so the exact path convention isn't established.
**Question**: Is the scoped Docker config directory `<projectDir>/.docker/` (containing `config.json`), and should the cleanup delete the entire `.docker/` directory or just the `config.json` file inside it?
**Options**:
- A: Delete just `<projectDir>/.docker/config.json` (leave directory)
- B: Delete the entire `<projectDir>/.docker/` directory (cleaner)

**Answer**: B** — delete the entire scoped docker config directory.

The CLI created it; it owns the lifecycle. No orphaned empty dir.

**Path correction**: per #641 Q4 resolution, the scoped config lives at `<projectDir>/.generacy/.docker/`, not project root `<projectDir>/.docker/`. The `.generacy/` directory is already CLI-managed and inherits the gitignore convention. Plan doc will be updated to reflect this.
