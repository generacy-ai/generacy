# Feature Specification: CLI Cluster Lifecycle Commands

Implement the cluster-lifecycle subcommands of the new `generacy` CLI.

**Branch**: `494-context-implement-cluster` | **Date**: 2026-04-29 | **Status**: Draft

## Summary

Add six cluster-lifecycle CLI commands (`up`, `stop`, `down`, `destroy`, `status`, `update`) to `packages/cli/`. These commands wrap Docker Compose operations against a project's `.generacy/cluster.yaml`, providing a user-friendly interface for managing local Generacy clusters. Commands run in cwd-mode, discovering cluster config by walking the directory tree upward.

## Context

These commands are part of the v1.5 CLI design (phase 5). They operate against an existing `.generacy/cluster.yaml` created during cluster bootstrap. Architecture reference: [docs/dev-cluster-architecture.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/dev-cluster-architecture.md) — "CLI design".

The CLI package (`packages/cli/`) does not exist yet — this is greenfield.

## Scope

Implement in `packages/cli/src/commands/`:

- `up` — `docker compose up -d` against the project's compose file. Project name = cluster ID. Refresh the registry's `lastSeen`.
- `stop` — `docker compose stop`. Containers preserved.
- `down` — `docker compose down` (named volumes preserved unless `--volumes`).
- `destroy` — `docker compose down -v` AND remove the cluster directory after confirmation prompt (skip prompt with `--yes`). Removes the registry entry.
- `status` — list all clusters from the registry with current Compose state (running/stopped/missing) for each. JSON output via `--json`.
- `update` — `docker compose pull` + restart.

Shared helpers:
- `getClusterContext(cwd)` — locates `.generacy/cluster.yaml` upward, returns parsed config or throws "no cluster here".
- `dockerComposeArgs(context)` — builds `--project-name=<id>` and `--file=<path>` consistently.

Error messages must be user-friendly: missing Docker, missing compose file, etc.

## User Stories

### US1: Developer starts a local cluster

**As a** developer with a bootstrapped project,
**I want** to run `generacy up` from my project directory,
**So that** the cluster containers start in the background without memorizing Docker Compose flags.

**Acceptance Criteria**:
- [ ] `generacy up` discovers `.generacy/cluster.yaml` by walking upward from cwd
- [ ] Containers start via `docker compose up -d` with the correct project name and compose file
- [ ] The registry's `lastSeen` timestamp is refreshed on success
- [ ] Clear error if `.generacy/cluster.yaml` is not found

### US2: Developer checks cluster status

**As a** developer managing multiple clusters,
**I want** to run `generacy status` to see all registered clusters and their state,
**So that** I can quickly identify which clusters are running, stopped, or missing.

**Acceptance Criteria**:
- [ ] Lists all clusters from the registry with their Compose state (running/stopped/missing)
- [ ] Human-readable table output by default
- [ ] `--json` flag produces machine-readable JSON matching a documented schema

### US3: Developer tears down a cluster permanently

**As a** developer finished with a project,
**I want** to run `generacy destroy` to remove volumes and the cluster directory,
**So that** I can fully clean up resources without manual steps.

**Acceptance Criteria**:
- [ ] Prompts for confirmation before destructive action
- [ ] `--yes` flag skips the confirmation prompt
- [ ] Answering `n` cancels the operation
- [ ] Removes volumes via `docker compose down -v`, deletes cluster directory, and removes registry entry

### US4: Developer updates cluster images

**As a** developer,
**I want** to run `generacy update` to pull latest images and restart,
**So that** my cluster stays current without manual Docker commands.

**Acceptance Criteria**:
- [ ] Pulls latest images via `docker compose pull`
- [ ] Restarts containers with the new images

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `getClusterContext(cwd)` walks upward from cwd to find `.generacy/cluster.yaml` and returns parsed config | P1 | Throws descriptive error if not found |
| FR-002 | `dockerComposeArgs(context)` builds consistent `--project-name` and `--file` flags | P1 | Project name = cluster ID from config |
| FR-003 | `up` runs `docker compose up -d` and refreshes registry `lastSeen` | P1 | |
| FR-004 | `stop` runs `docker compose stop` (containers preserved) | P1 | |
| FR-005 | `down` runs `docker compose down`; `--volumes` flag adds `-v` | P1 | |
| FR-006 | `destroy` runs `docker compose down -v`, removes cluster dir, removes registry entry | P1 | Confirmation prompt required; `--yes` skips |
| FR-007 | `status` lists all registered clusters with Compose state | P1 | Supports `--json` flag |
| FR-008 | `update` runs `docker compose pull` then restarts | P2 | |
| FR-009 | All commands fail fast with clear message when Docker is not running | P1 | Check Docker availability before any operation |
| FR-010 | Error messages are user-friendly for common failure modes | P1 | Missing Docker, missing compose file, missing config |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | All 6 commands execute correctly | 100% | Integration tests against fixture compose file |
| SC-002 | Helpers have unit test coverage | 100% of helpers | Unit tests for `getClusterContext` and `dockerComposeArgs` |
| SC-003 | `status --json` output matches schema | Valid JSON | Schema validation in tests |
| SC-004 | Fail-fast on missing Docker | < 1s to error | Manual + automated test |
| SC-005 | `destroy` confirmation flow works | Both paths tested | `--yes` skips, `n` cancels |

## Assumptions

- Docker and Docker Compose v2 are installed on the developer's machine
- `.generacy/cluster.yaml` and the compose file are created by a prior bootstrap step (not part of this feature)
- A cluster registry (local file) exists to track registered clusters for `status` and `destroy`
- The CLI framework/library choice (e.g., commander, yargs, oclif) will be decided during planning

## Out of Scope

- Cluster bootstrapping / `init` command (handled by prior phase)
- Remote cluster management
- Log streaming (`logs` command)
- Shell access to containers (`exec` / `shell` commands)
- CI/CD integration or headless provisioning

---

*Generated by speckit*
