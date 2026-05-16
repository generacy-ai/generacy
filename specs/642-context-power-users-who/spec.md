# Feature Specification: ## Context

Power users who bypass the cloud UI (Flow C — local power-user) need a CLI command to set registry credentials for the project's private image

**Branch**: `642-context-power-users-who` | **Date**: 2026-05-16 | **Status**: Draft

## Summary

## Context

Power users who bypass the cloud UI (Flow C — local power-user) need a CLI command to set registry credentials for the project's private image. This avoids requiring them to round-trip through generacy.ai for credentials they could otherwise enter at the terminal.

To prevent cross-project credential bleed, the command writes to project-scoped `<projectDir>/.docker/config.json` — **not** the user's `~/.docker/config.json`. Users who explicitly want machine-wide auth use `docker login` directly; the CLI documents this distinction in its help text.

Part of [docs/cluster-variants-and-custom-images-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cluster-variants-and-custom-images-plan.md) — Phase 2 Track B.

## Scope

- **New subcommand** `generacy registry-login <registry-host>`:
  - Interactive prompts for username + token (token field uses no-echo input).
  - Writes to `<projectDir>/.docker/config.json` for that host.
  - If the cluster is running, also forwards to credhelper via the control-plane (same as the post-launch forward in the sibling issue) so that future `generacy update` runs work even without the scoped config.
- **Help text** clarifies scope:
  ```
  generacy registry-login <host>
    Authenticate with a private container registry for this project's cluster.
    Credentials are scoped to this project directory and forwarded to the running
    cluster's credhelper if available. To set machine-wide credentials, use
    'docker login' directly.
  ```
- **`generacy registry-logout <registry-host>`**: removes both the scoped config entry and the credhelper entry. Useful for credential rotation.

## Acceptance criteria

- `registry-login` writes a valid docker config that `docker compose pull` can use.
- Token entry does not echo to terminal.
- `~/.docker/config.json` is never modified.
- If cluster is running, credhelper receives the credential.
- `registry-logout` cleanly removes both sources.
- Tests cover: scoped write, cluster-running forward, cluster-offline scope-only, logout.

## Out of scope

- Cloud UI sync (the cloud doesn't learn about manually-entered creds; that's fine — the credhelper is the source of truth and the `Project.image.registryHasCredentials` flag stays unchanged unless the user does it via the cloud UI).

## User Stories

### US1: Power user authenticates with private registry

**As a** local power user (Flow C),
**I want** to set registry credentials from the CLI,
**So that** I can pull private images without round-tripping through the cloud UI.

**Acceptance Criteria**:
- [ ] `generacy registry-login <host>` prompts for username + token (no-echo)
- [ ] Writes valid Docker config to `<projectDir>/.generacy/.docker/config.json`
- [ ] `~/.docker/config.json` is never modified
- [ ] If cluster is running, forwards credential via `docker compose exec` to control-plane
- [ ] `generacy registry-logout <host>` removes scoped config entry and control-plane credential

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Interactive prompt for username + token (no-echo input) | P1 | Use `@clack/prompts` password field |
| FR-002 | Write Docker config to `<projectDir>/.generacy/.docker/config.json` | P1 | Standard Docker `config.json` format with `auths.<host>.auth` = base64(user:token) |
| FR-003 | Never modify `~/.docker/config.json` | P1 | Hard requirement |
| FR-004 | Forward credential to control-plane if cluster running | P1 | Via `docker compose exec orchestrator curl --unix-socket /run/generacy-control-plane/control.sock PUT /credentials/registry-<host>` |
| FR-005 | Credential value format: JSON `{"username":"...","password":"..."}` | P1 | Host derived from credentialId; consistent with sibling issues |
| FR-006 | Store in control-plane with type `docker-registry` (no credhelper plugin) | P1 | Plugin deferred to v1.7 |
| FR-007 | `compose.ts` helper auto-detects `<projectDir>/.generacy/.docker/config.json` and sets `DOCKER_CONFIG` env var on spawn | P1 | Applies to `up`, `update`, `pull`, all compose commands |
| FR-008 | `registry-logout` removes scoped config entry and control-plane credential | P2 | |
| FR-009 | Help text clarifies project-scoped vs machine-wide distinction | P2 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `docker compose pull` succeeds with scoped config | Pass | Integration test with private registry |
| SC-002 | Token never echoed to terminal | Pass | Manual verification |
| SC-003 | `~/.docker/config.json` unchanged after command | Pass | Unit test |
| SC-004 | Cross-terminal session auto-detect works | Pass | Test: write config, new process runs `generacy update` successfully |

## Assumptions

- The project directory has a `.generacy/` subdirectory (standard cluster scaffold)
- Docker config path is `<projectDir>/.generacy/.docker/config.json` (inside `.generacy/` to keep project root clean)
- The `compose.ts` helper is the single point where all `docker compose` invocations pass through
- Control-plane `PUT /credentials/:id` endpoint already accepts arbitrary type strings

## Out of Scope

- Cloud UI sync (cloud doesn't learn about manually-entered creds)
- New credhelper plugin for `docker-registry` (deferred to v1.7)
- Machine-wide Docker auth (users use `docker login` directly)

---

*Generated by speckit*
