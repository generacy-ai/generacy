# Research: `scaffoldDockerCompose` `volume`-mode fix

## Scope

This document captures the technology and design decisions made for [#737](https://github.com/generacy-ai/generacy/issues/737). The fundamental approach choices were resolved in [clarifications.md](./clarifications.md) (Q1–Q5); this file consolidates them into a single decision log with rationale and links the upstream sources.

## Decisions

### D1: Replace named-volume-on-file with a compose-relative file bind

- **Decision**: In `claudeConfigMode === 'volume'`, emit `./claude.json:/home/node/.claude.json` and remove the top-level `claude-config:` volume entry.
- **Rationale**: Docker named volumes are *directories*; binding one onto a file path is a Docker daemon error (`is not directory`). The canonical cluster-base devcontainer compose already binds `.claude.json` as a file and only uses a named volume for the `.claude/` *directory*. A compose-relative path keeps the encoding identical between `launch` (local) and `deploy` (SCP'd bundle dir on a VM), without smuggling host-absolute paths into the emitted YAML.
- **Alternatives considered**:
  - **Drop the mount in `volume` mode** (ephemeral `.claude.json` inside the container layer). Rejected — loses Claude session on every container recreation; defeats the purpose of a "volume" mode.
  - **Collapse `volume` mode to behave identically to `bind`** (both mount `~/.claude.json`). Rejected — loses per-cluster isolation, which is a meaningful product distinction.
  - **Configurable bind path via a new `ScaffoldComposeInput` field**. Rejected — adds API surface for a value that is deterministic given the scaffold directory.
- **Source**: [clarifications.md Q1, Q2](./clarifications.md); [generacy-ai/generacy-cloud#782](https://github.com/generacy-ai/generacy-cloud/pull/782) (upstream cloud fix with identical intent).

### D2: Scaffolder writes a blank `claude.json` if missing; never overwrites

- **Decision**: When `claudeConfigMode === 'volume'`, `scaffoldDockerCompose` writes `<scaffoldDir>/claude.json` containing `{}\n` only if the file does not already exist. Existing files (any content, including zero-byte) are left untouched.
- **Rationale**: After first `claude /login` the file holds a real session token. `generacy update` / `generacy launch` may re-run the scaffolder; overwriting would force re-login on every re-scaffold. A zero-byte file from a partial prior run is still a valid empty bind target — no need to recreate it. Mirrors cloud-init's `test -f … || install …` pattern from the cloud fix.
- **Alternatives considered**:
  - **Always overwrite with `{}`** — deterministic, but destroys real sessions. Rejected.
  - **Skip if exists *and* non-empty, recreate if zero-byte** — extra branch for a case that already works. Rejected.
  - **Defer file creation to the caller** — splits responsibility unnecessarily; both callers want the same behavior. Rejected.
- **Source**: [clarifications.md Q4](./clarifications.md); [generacy-ai/generacy-cloud#782](https://github.com/generacy-ai/generacy-cloud/pull/782).

### D3: Best-effort `chown 1000:1000`, warn-and-continue on permission error

- **Decision**: After creating `claude.json`, the scaffolder calls `chownSync(path, 1000, 1000)` inside a try/catch. On `EPERM`/`EACCES` (typical on non-root developer laptops) it logs a `warn`-level message via the package logger and returns successfully. Other errors propagate.
- **Rationale**: The cluster image runs orchestrator/worker as `node` (uid 1000). If the host-side file is owned by some other uid, the container can mount it but may not be able to write to it. Where the scaffolder runs as root (CI, some `deploy` flows), the chown gets it right; where it can't, we degrade to the same behavior `bind` mode has shipped with for years (which depends on Linux first-user being uid 1000 / Docker Desktop's bind remapping).
- **Why not other approaches**:
  - **Skip chown entirely and have the cluster image fix it at boot**: The cluster image's entrypoint sudoers is narrowly scoped to `chmod 666` on the docker socket; it cannot `chown` `.claude.json`. Verified in `entrypoint-orchestrator.sh:11-22`.
  - **Run the container as the host's uid (`user: "${UID:-1000}:${GID:-1000}"`)**: Breaks pervasive uid-1000 assumptions (credhelper uid 1002, tmpfs `uid=1000`, `/var/lib/generacy` ownership).
  - **`chmod 0666` on the token file**: Poor security posture for a credential file.
- **Source**: [clarifications.md Q3](./clarifications.md); cluster-base `entrypoint-orchestrator.sh:11-22`.

### D4: Defense-in-depth ownership fix in `remote-compose.ts`

- **Decision**: In `remote-compose.ts`, before `docker compose pull`, run an idempotent SSH command of the form:
  ```sh
  test -f "${remotePath}/claude.json" \
    || install -o 1000 -g 1000 -m 0600 /dev/null "${remotePath}/claude.json"; \
  chown 1000:1000 "${remotePath}/claude.json" 2>/dev/null || true
  ```
  The `|| true` keeps it best-effort when the SSH user lacks privilege.
- **Rationale**: SCP lands files owned by the deploy SSH user. On many targets that user is not uid 1000 (e.g. `ubuntu`, custom deploy accounts). The scaffolder's local `chownSync` cannot fix this because it ran on the developer's laptop, not the VM. Per D3, the container cannot self-correct ownership. A small remote-side belt-and-braces step costs one extra `ssh` round trip and fixes the common-case mismatch.
- **Alternatives considered**:
  - **Scaffolder-only** — leaves SCP'd files owned wrong on the VM. Rejected.
  - **`remote-compose.ts`-only** — bypasses the local `launch` path entirely. Rejected.
  - **Both** (chosen) — scaffolder ensures local correctness for `launch`, remote-compose ensures VM correctness for `deploy`. Slight redundancy is intentional; each path is the right tool for its environment.
- **Source**: [clarifications.md Q5](./clarifications.md).

### D5: `bind`-mode output is byte-identical

- **Decision**: Do not touch the `bind` branch of `scaffoldDockerCompose`. The emitted YAML for an identical `ScaffoldComposeInput` with `claudeConfigMode: 'bind'` must be byte-equal before and after this change.
- **Rationale**: SC-002 explicitly requires it; `generacy launch` (the dominant local-dev caller) is on the `bind` path and any drift forces a re-scaffold for thousands of existing clusters with no benefit. The change MUST be additive: a new `if (claudeConfigMode === 'volume')` branch that writes the file and emits the relative bind, with the existing `bind`-branch literals untouched.
- **Verification**: A `vitest` snapshot test in `scaffolder.test.ts` captures the full YAML output for `bind` mode and asserts byte-equality after the fix lands.

## Implementation Pattern References

- **Existing scaffolder structure**: `packages/generacy/src/cli/commands/cluster/scaffolder.ts` — single-file scaffolder with helper-per-artifact (`scaffoldClusterJson`, `scaffoldClusterYaml`, `scaffoldDockerCompose`, `scaffoldEnvFile`). The fix stays inside `scaffoldDockerCompose`; no new helper is justified for a one-shot `writeFileSync` + `chownSync`.
- **Idempotent file write pattern in this repo**: `existsSync(path) || writeFileSync(path, content)` (atomic for our needs — no concurrent scaffolder calls).
- **Logger usage**: `getLogger()` from `../../utils/logger.js`, used elsewhere in deploy/launch flows (`remote-compose.ts:16` etc.). Warnings go through `logger.warn(...)`.
- **SSH command pattern**: `sshExec(target, cmd)` from `./ssh-client.js` already used in `remote-compose.ts` for pull/up. Same call shape for the ownership-fix command.

## Open Risks / Follow-ups

- **macOS Docker Desktop**: Bind-mounted host files are uid-remapped to the container user, so on macOS the `chown` step is moot (mount Just Works regardless). No special-case code needed; the warning is informational.
- **Already-broken clusters on disk**: Users with a previously scaffolded `volume`-mode cluster (whose orchestrator never started) re-run `generacy launch`/`deploy` to pick up the fix. The broken named volume never successfully wrote anything, so there is no migration. Out of scope per spec.
- **Cloud-side template**: generacy-cloud's cloud-deploy template was patched separately in generacy-ai/generacy-cloud#782. This issue is the in-tree mirror only.
