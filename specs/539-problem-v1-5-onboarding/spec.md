# Feature Specification: Concurrent Local Clusters — Port & Volume Conflicts

**Branch**: `539-problem-v1-5-onboarding` | **Date**: 2026-05-07 | **Status**: Draft

## Summary

The v1.5 onboarding doc promises users can run multiple clusters simultaneously, but the scaffolded `docker-compose.yml` makes that impossible due to hardcoded host port bindings and shared volume names. This issue tracks the work to deliver concurrent local clusters.

## Problem

[`scaffoldDockerCompose` in cluster/scaffolder.ts](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/scaffolder.ts#L62-L89) currently emits:

1. **No top-level `name:` field** — Docker Compose derives the project name from the compose file's parent directory (`<projectDir>/.generacy/`), which sanitizes to `generacy`. Every project shows up under the same compose name in `docker compose ls` / Docker Desktop.
2. **Hardcoded host port bindings** — `3100:3100`, `3101:3101`, `3102:3102`. The second cluster started on the same machine fails to bind.
3. **Hardcoded named volume** — `cluster-data`. Combined with #1, simultaneous clusters share the same Docker volume and overwrite each other's state.

A separate small PR addresses #1 (and incidentally #3 — Compose namespaces volumes by project name once the project has a real name). This issue tracks the rest of the work to actually deliver concurrent local clusters.

## Decisions (from clarify phase)

- **Port allocation**: Ephemeral Docker-assigned ports. Drop `HOST:CONTAINER` syntax, let Docker assign random host ports. Simplest scaffolder, zero collision risk. A `--port-base` flag can be layered on later if users request predictable ports.
- **Port bindings**: Only port 3100 (orchestrator) needs a host binding. Port 3101 (relay) is outbound-only WebSocket, port 3102 (control plane) is Unix-socket-only. Remove 3101 and 3102 host-port mappings from the scaffolder entirely.
- **`generacy open`**: No change needed — keeps cloud URL behavior (`${cloudUrl}/clusters/${clusterId}`). Port discovery is only relevant for `generacy status` output.
- **Migration**: Manual migration with a warning. `generacy up` warns when it detects legacy hardcoded port bindings, pointing users to delete `.generacy/docker-compose.yml` and re-run.
- **Deploy command**: Dynamic ports apply only when `deploymentMode === 'local'`. Deploy (remote SSH) keeps fixed `3100:3100` binding since remote VMs are single-cluster.

## Scope

### Code changes

- **Scaffolder** (`packages/generacy/src/cli/commands/cluster/scaffolder.ts`):
  - When `deploymentMode === 'local'`: emit only port 3100 as ephemeral (`"3100"` instead of `"3100:3100"`). Remove 3101 and 3102 port mappings entirely.
  - When `deploymentMode === 'cloud'` (deploy path): keep fixed `"3100:3100"` binding; still remove 3101/3102.
- **`generacy status`** (`packages/generacy/src/cli/commands/status/index.ts`): query live Docker port mappings via `docker compose ps --format json` and surface the actual assigned host port for 3100.
- **`generacy up`** (`packages/generacy/src/cli/commands/up/index.ts`): detect legacy hardcoded port format in existing compose files; emit a warning with migration instructions.
- **Registry** (`~/.generacy/clusters.json`): no schema change needed — ports are queried live from Docker, not cached.

### Doc changes

- **onboarding-v1.5.md**: update Flow C's "Run multiple clusters concurrently" section to reflect ephemeral ports and single-port binding. Remove or rewrite the troubleshooting entry "Multiple clusters conflict on ports → edit the compose file."

### Out of scope

- `generacy open` changes (keeps cloud URL behavior)
- Remote/SSH deploy port changes (keeps fixed binding)
- Auto-migration of existing compose files
- `--port-base` flag for user-specified port offsets (future enhancement)

## User Stories

### US1: Run Multiple Local Clusters

**As a** developer,
**I want** to run multiple Generacy clusters simultaneously on my machine,
**So that** I can work on separate projects without port conflicts or data corruption.

**Acceptance Criteria**:
- [ ] `generacy launch` scaffolds a compose file with ephemeral port for 3100 only (no 3101/3102 host bindings)
- [ ] Two clusters started concurrently both come up successfully without port conflicts
- [ ] `generacy status` shows the actual Docker-assigned host port for each running cluster
- [ ] `generacy up` on an existing cluster with legacy hardcoded ports emits a warning with migration steps

### US2: Clear Status Display

**As a** developer with multiple running clusters,
**I want** `generacy status` to show the real port assignments,
**So that** I know how to reach each cluster's orchestrator locally.

**Acceptance Criteria**:
- [ ] `generacy status` queries Docker for live port mappings
- [ ] Output includes the host port mapped to container port 3100 for each cluster
- [ ] `--json` output includes port information in machine-readable format

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Scaffolder emits ephemeral port for 3100 when `deploymentMode === 'local'` | P1 | Drop `HOST:` prefix |
| FR-002 | Scaffolder removes 3101 and 3102 host-port mappings | P1 | Dead code — relay is outbound-only, control plane is Unix socket |
| FR-003 | Scaffolder keeps fixed `3100:3100` when `deploymentMode === 'cloud'` | P1 | Remote VMs need predictable ports |
| FR-004 | `generacy status` queries live Docker port mappings | P1 | Via `docker compose ps --format json` |
| FR-005 | `generacy up` warns on legacy hardcoded port format | P2 | Detection + migration instructions |
| FR-006 | Update onboarding-v1.5.md Flow C section | P2 | Reflect ephemeral ports, single binding |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Concurrent clusters | 2+ clusters run simultaneously without port conflicts | Manual test: launch two clusters, both healthy |
| SC-002 | Status accuracy | `generacy status` shows correct live port for each cluster | Compare output against `docker compose ps` |

## Assumptions

- Docker Compose v2 is used (supports `--format json` on `ps`)
- The companion PR for the `name:` field fix has landed (volume namespacing resolved)
- Only the orchestrator (port 3100) needs host-accessible binding for local workflow

## Background

Surfaced during v1.5 staging walkthrough. The user landed in `~/Generacy/todo-list-example16/` and saw their cluster appear as `generacy` in Docker Desktop, with the inner container named after the cluster id rather than the project name. The cluster came up because no other Generacy cluster was running locally, but this UX falls over the moment a user wants two side-by-side projects.

## Related

- Companion PR for the immediate `name:` fix (links once opened)
- v1.5 onboarding doc: `docs/onboarding-v1.5.md`
- `scaffoldDockerCompose` and `ScaffoldComposeInput` in `packages/generacy/src/cli/commands/cluster/scaffolder.ts`

---

*Generated by speckit*
