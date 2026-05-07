# Feature Specification: Concurrent Local Clusters (Dynamic Ports + Per-Project Namespacing)

**Branch**: `539-problem-v1-5-onboarding` | **Date**: 2026-05-07 | **Status**: Draft

## Summary

Enable running multiple Generacy clusters concurrently on the same machine by eliminating hardcoded host port bindings in the scaffolded `docker-compose.yml` and updating all CLI commands to discover ports dynamically. This delivers the "Flow C" promise from the v1.5 onboarding doc.

## Problem

The v1.5 onboarding doc promises users can run multiple clusters simultaneously ([Flow C, "Run multiple clusters concurrently"](https://github.com/generacy-ai/generacy/blob/develop/docs/onboarding-v1.5.md)), but the scaffolded `docker-compose.yml` makes that impossible.

[`scaffoldDockerCompose` in cluster/scaffolder.ts](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cluster/scaffolder.ts#L62-L89) currently emits:

1. **No top-level `name:` field** — Docker Compose derives the project name from the compose file's parent directory (`<projectDir>/.generacy/`), which sanitizes to `generacy`. Every project shows up under the same compose name in `docker compose ls` / Docker Desktop.
2. **Hardcoded host port bindings** — `3100:3100`, `3101:3101`, `3102:3102`. The second cluster started on the same machine fails to bind.
3. **Hardcoded named volume** — `cluster-data`. Combined with #1, simultaneous clusters share the same Docker volume and overwrite each other's state.

A separate small PR addresses #1 (and incidentally #3 — Compose namespaces volumes by project name once the project has a real name). This issue tracks the rest of the work to actually deliver concurrent local clusters.

## Scope

### Code changes

- **Scaffolder** (`packages/generacy/src/cli/commands/cluster/scaffolder.ts`): emit ports in a way that doesn't force a host-port pin. Two viable strategies, to be decided in the clarify phase:
  - **Ephemeral** — drop `HOST:CONTAINER` syntax, let Docker assign random host ports (`"3100"` instead of `"3100:3100"`).
  - **Per-project offset** — compute a deterministic offset from the project name or cluster id (`3100 + N*10`) and write fixed bindings.
- **Registry** (`~/.generacy/clusters.json`): record the actual assigned host ports per cluster, or document that they should be queried live via Docker.
- **`generacy status`**: surface the real port assignments. Currently the doc says it lists "state, and ports" — that breaks if ports are dynamic.
- **`generacy open`**: discover the cluster's UI port instead of assuming `3100`.
- **Cluster control plane**: confirm whether anything inside the container needs to know its own externally-mapped port (e.g. for OAuth callbacks, browser-editor URLs surfaced through the relay) and propagate it if so.

### Doc changes

- **onboarding-v1.5.md**: update Flow C's "Run multiple clusters concurrently" section to reflect the actual UX, and remove or rewrite the troubleshooting entry "Multiple clusters conflict on ports → edit the compose file" (which would no longer apply).

## Open questions for clarify phase

- Q1: Ephemeral Docker-assigned ports vs deterministic per-project offsets? Trade-off: ephemeral is simpler in the scaffolder but requires every CLI command to query Docker; offsets are predictable but still risk collisions across many clusters.
- Q2: Does any in-cluster service need to advertise its own externally-mapped port (e.g. for relay callbacks, IDE-tunnel handshakes)? If yes, the launch/up flow needs to discover the assigned port and inject it into the running cluster.
- Q3: Where does `generacy status` source port data from — `~/.generacy/clusters.json` (cached, can drift) or `docker compose ps --format json` per call (live, slower)?
- Q4: Migration story for clusters scaffolded under the current code? They have hardcoded ports + colliding volume names. Do we auto-fix on next `generacy up`, or document a manual migration?

## Background

Surfaced during v1.5 staging walkthrough. The user landed in `~/Generacy/todo-list-example16/` and saw their cluster appear as `generacy` in Docker Desktop, with the inner container named after the cluster id rather than the project name. The cluster came up because no other Generacy cluster was running locally, but this UX falls over the moment a user wants two side-by-side projects.

## Related

- Companion PR for the immediate `name:` fix (links once opened)
- v1.5 onboarding doc: `docs/onboarding-v1.5.md`
- `scaffoldDockerCompose` and `ScaffoldComposeInput` in `packages/generacy/src/cli/commands/cluster/scaffolder.ts`

## User Stories

### US1: Developer running multiple projects

**As a** developer working on multiple Generacy projects,
**I want** to run clusters for each project concurrently on my local machine,
**So that** I can switch between projects without manually stopping and starting clusters.

**Acceptance Criteria**:
- [ ] Running `generacy launch` or `generacy up` for a second project succeeds without port conflicts
- [ ] Each cluster is identifiable by project name in `docker compose ls` and Docker Desktop
- [ ] Each cluster has isolated data volumes (no cross-project state corruption)
- [ ] `generacy status` shows correct ports for each running cluster

### US2: Developer accessing cluster UI

**As a** developer with one or more clusters running,
**I want** `generacy open` and `generacy status` to show me the correct URL/port for each cluster,
**So that** I can access the right cluster's UI without guessing ports.

**Acceptance Criteria**:
- [ ] `generacy open` discovers the actual mapped port for the current project's cluster
- [ ] `generacy status` displays live port mappings for all registered clusters
- [ ] Port information is accurate even after Docker restarts (no stale cached data)

### US3: Existing user upgrading

**As an** existing Generacy user with clusters scaffolded under the old hardcoded-port scheme,
**I want** a clear migration path to the new dynamic port model,
**So that** I can adopt concurrent clusters without manually editing compose files.

**Acceptance Criteria**:
- [ ] Existing clusters continue to work after CLI upgrade
- [ ] Migration path is documented or automated (decision pending Q4)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Scaffolder emits compose files without hardcoded host port bindings | P1 | Strategy TBD (ephemeral vs offset) |
| FR-002 | `generacy status` displays live port assignments per cluster | P1 | Query Docker at runtime |
| FR-003 | `generacy open` discovers the cluster's UI port dynamically | P1 | No hardcoded port assumption |
| FR-004 | Registry (`~/.generacy/clusters.json`) supports port metadata or defers to live query | P2 | Decision linked to Q1/Q3 |
| FR-005 | Named volumes are per-project (no cross-cluster data sharing) | P1 | Largely solved by `name:` fix in companion PR |
| FR-006 | In-cluster services that need their external port receive it via env var or config | P2 | Decision linked to Q2 |
| FR-007 | `onboarding-v1.5.md` Flow C section reflects actual concurrent-cluster UX | P2 | |
| FR-008 | Migration path for existing hardcoded-port clusters | P2 | Decision linked to Q4 |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Concurrent clusters | 2+ clusters run simultaneously without port conflicts | Manual test: `generacy launch` two projects |
| SC-002 | Port discovery accuracy | `generacy status` and `generacy open` show correct ports 100% of the time | Verify against `docker compose ps` output |
| SC-003 | Data isolation | Zero cross-cluster volume sharing | Inspect Docker volumes after running two clusters |
| SC-004 | Existing cluster compat | Clusters scaffolded before this change continue to start | Upgrade CLI, run `generacy up` on old project |

## Assumptions

- The companion PR for the `name:` field fix lands first (resolves project naming + volume namespacing)
- Docker Compose v2 is the minimum supported version (supports `name:` field and `--format json`)
- Node >= 22 runtime (per existing CLI requirements)
- `docker compose ps --format json` is reliable for querying live port mappings

## Out of Scope

- Remote/SSH cluster port management (deploy command targets are not local; port conflicts don't apply)
- Multi-host cluster orchestration
- Custom user-defined port overrides (can be a follow-up if needed)
- Container-to-container networking changes (internal service ports are unaffected)

---

*Generated by speckit*
