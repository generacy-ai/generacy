# Feature Specification: `generacy registry-login` subcommand

**Branch**: `642-context-power-users-who` | **Date**: 2026-05-16 | **Status**: Draft

## Summary

Add `generacy registry-login <registry-host>` and `generacy registry-logout <registry-host>` CLI subcommands for power users (Flow C) to authenticate with private container registries without round-tripping through the cloud UI. Credentials are project-scoped (written to `<projectDir>/.docker/config.json`) and optionally forwarded to the running cluster's credhelper.

## Context

Power users who bypass the cloud UI (Flow C — local power-user) need a CLI command to set registry credentials for the project's private image. This avoids requiring them to round-trip through generacy.ai for credentials they could otherwise enter at the terminal.

To prevent cross-project credential bleed, the command writes to project-scoped `<projectDir>/.docker/config.json` — **not** the user's `~/.docker/config.json`. Users who explicitly want machine-wide auth use `docker login` directly; the CLI documents this distinction in its help text.

Part of [docs/cluster-variants-and-custom-images-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cluster-variants-and-custom-images-plan.md) — Phase 2 Track B.

## User Stories

### US1: Power user authenticates with private registry

**As a** power user running a local cluster with a custom image,
**I want** to authenticate with my private container registry via the CLI,
**So that** `docker compose pull` can pull my custom image without requiring cloud UI interaction.

**Acceptance Criteria**:
- [ ] Running `generacy registry-login ghcr.io` prompts for username and token
- [ ] Token input does not echo to terminal
- [ ] Credentials are written to `<projectDir>/.docker/config.json`
- [ ] `docker compose pull` succeeds using the scoped config
- [ ] `~/.docker/config.json` is never modified

### US2: Running cluster receives forwarded credentials

**As a** power user with a running cluster,
**I want** registry credentials to be forwarded to the cluster's credhelper,
**So that** future `generacy update` commands work without re-entering credentials.

**Acceptance Criteria**:
- [ ] If cluster is running, credhelper receives the credential via control-plane
- [ ] If cluster is not running, only the scoped config is written (no error)
- [ ] Forwarding failure is non-fatal (scoped config still written)

### US3: Power user rotates or removes registry credentials

**As a** power user rotating registry tokens,
**I want** to cleanly remove credentials from both the scoped config and credhelper,
**So that** stale tokens don't persist in either location.

**Acceptance Criteria**:
- [ ] `generacy registry-logout ghcr.io` removes the host entry from scoped config
- [ ] If cluster is running, credhelper entry is also removed
- [ ] Command succeeds even if only one location has the credential

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `registry-login <host>` prompts interactively for username + token | P1 | Token uses no-echo input (`@clack/prompts` password field) |
| FR-002 | Writes base64-encoded auth to `<projectDir>/.docker/config.json` | P1 | Standard Docker config format: `{"auths":{"host":{"auth":"base64"}}}` |
| FR-003 | Merges with existing scoped config (doesn't overwrite other hosts) | P1 | Atomic read-modify-write |
| FR-004 | Forwards credential to control-plane if cluster is running | P2 | PUT to control-plane `/credentials/registry-<host>` via relay or direct |
| FR-005 | `registry-logout <host>` removes entry from scoped config | P1 | |
| FR-006 | `registry-logout <host>` removes credhelper entry if cluster running | P2 | DELETE to control-plane |
| FR-007 | Help text documents project-scoped vs machine-wide distinction | P1 | |
| FR-008 | Sets `DOCKER_CONFIG` env var in generated docker-compose to point at scoped config | P1 | Required for `docker compose pull` to use scoped config |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Scoped config is valid Docker auth JSON | 100% | `docker compose pull` succeeds with scoped config |
| SC-002 | No modification to `~/.docker/config.json` | 0 writes | Assertion in tests |
| SC-003 | Token never visible in terminal output | 100% | No-echo verified in tests |
| SC-004 | Credential forward works when cluster is running | Pass | Integration test with running cluster |
| SC-005 | Logout removes from both sources | Pass | Unit + integration tests |

## Technical Notes

- Docker config format: `{"auths":{"<host>":{"auth":"<base64(username:token)>"}}}`
- Scoped config path: `<projectDir>/.docker/config.json` (sibling to `.generacy/`)
- `DOCKER_CONFIG=<projectDir>/.docker` must be set in compose environment for pull to use it
- Cluster-forward path: control-plane `PUT /credentials/registry-<host>` (same pattern as wizard credential writes in #558)
- Uses `getClusterContext()` from `src/cli/utils/cluster-context.ts` to resolve project directory
- Interactive prompts via `@clack/prompts` (consistent with existing CLI UX)

## Assumptions

- The `.docker/config.json` format with base64 `auth` field is sufficient (no credential helpers or OAuth token flows needed)
- Control-plane credential forwarding follows the existing `PUT /credentials/:id` route pattern
- The scoped docker config directory (`.docker/`) can live at project root alongside `.generacy/`

## Out of Scope

- Cloud UI sync (cloud doesn't learn about manually-entered creds)
- OAuth/device-flow registry auth (only username+token supported)
- Automatic credential refresh or expiry handling
- Registry health-check / login verification (`docker login --verify` equivalent)

---

*Generated by speckit*
