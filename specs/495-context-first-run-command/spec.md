# Feature Specification: CLI Launch Command (Claim-Code First-Run Flow)

**Branch**: `495-context-first-run-command` | **Date**: 2026-04-29 | **Status**: Draft

## Summary

Implement the `generacy launch` CLI command — the first-run experience that bootstraps a brand-new cluster from a cloud-issued claim code. The command validates prerequisites, fetches launch configuration from the cloud, scaffolds the project directory with Docker Compose and cluster config, starts the cluster, and opens the activation URL in the user's browser.

## Context

The first-run command. `npx generacy launch --claim=<code>` (or with no claim, prompts for one) bootstraps a brand-new cluster from a cloud-issued claim. Architecture: [docs/dev-cluster-architecture.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/dev-cluster-architecture.md) — "CLI design" and "Onboarding flow B".

## Scope

Implement `packages/cli/src/commands/launch.ts`:

1. Validate Node version (already done by the CLI entry; reaffirm here for direct-import callers).
2. Validate Docker is reachable.
3. Read `--claim` arg or prompt for one.
4. Call `GET {GENERACY_CLOUD_URL}/api/clusters/launch-config?claim=<code>` (a small new cloud endpoint that returns the project's chosen variant, peer repos list, default cluster ID, and cloud URL — to be filed as a follow-up if not already; for this issue, use a stubbed response if the endpoint isn't yet ready and document the dependency).
5. Pick a project directory. Default `~/Generacy/<project-name>`. `--dir <path>` overrides. Confirm with the user before creating.
6. Write `.generacy/cluster.yaml` with the chosen variant image tag, port mappings, and cloud URL.
7. Write a top-level `docker-compose.yml` that pulls the published cluster image variant from GHCR (phase-6 dependency; for now, configurable via env var).
8. `docker compose pull` + `docker compose up -d`.
9. Stream cluster logs until the activation URL is printed; auto-open the URL in the user's default browser (`open` on macOS, `xdg-open` on Linux, `start` on Windows). On Linux, also print the URL.
10. Add the cluster to the registry.

## User Stories

### US1: New Developer Bootstraps a Cluster

**As a** developer onboarding to a Generacy-powered project,
**I want** to run a single CLI command with a claim code to set up my local cluster,
**So that** I can start working without manual Docker/config setup.

**Acceptance Criteria**:
- [ ] Running `npx generacy launch --claim=<code>` in a clean environment creates a working cluster
- [ ] The activation URL opens automatically in my browser
- [ ] The project directory is scaffolded with correct config files

### US2: Developer Chooses a Custom Project Directory

**As a** developer with a preferred workspace layout,
**I want** to specify where the project directory is created via `--dir`,
**So that** I can control my filesystem organization.

**Acceptance Criteria**:
- [ ] `--dir <path>` overrides the default `~/Generacy/<project-name>` location
- [ ] The command confirms the directory with the user before creating it

### US3: Developer Recovers from Failures

**As a** developer encountering infrastructure issues (no Docker, unreachable cloud, failed image pull),
**I want** clear error messages with remediation hints,
**So that** I can self-diagnose and fix problems without filing a support ticket.

**Acceptance Criteria**:
- [ ] Docker-not-found error suggests installation steps
- [ ] Cloud-unreachable error suggests checking network/URL
- [ ] Image-pull failure suggests checking Docker login / network

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Validate Node.js version meets minimum requirement | P1 | Re-affirm for direct-import callers |
| FR-002 | Validate Docker daemon is reachable (`docker info`) | P1 | |
| FR-003 | Accept `--claim` flag or interactively prompt for claim code | P1 | |
| FR-004 | Fetch launch config from `GET /api/clusters/launch-config?claim=<code>` | P1 | Stub response if endpoint not ready; document dependency |
| FR-005 | Resolve project directory: default `~/Generacy/<project-name>`, `--dir` override | P1 | Confirm with user before creating |
| FR-006 | Write `.generacy/cluster.yaml` (variant image tag, port mappings, cloud URL) | P1 | |
| FR-007 | Write `docker-compose.yml` referencing GHCR cluster image variant | P1 | Image registry configurable via env var |
| FR-008 | Run `docker compose pull` + `docker compose up -d` | P1 | |
| FR-009 | Stream container logs until activation URL appears | P1 | Regex or pattern match on URL |
| FR-010 | Auto-open activation URL in default browser (macOS: `open`, Linux: `xdg-open`, Windows: `start`) | P1 | Linux: also print URL to terminal |
| FR-011 | Register cluster in the local cluster registry | P1 | Cluster visible in `generacy status` |
| FR-012 | Provide user-friendly errors with remediation hints for all failure modes | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Happy-path completion | Clean `launch` boots a cluster and opens activation URL | Manual + integration test |
| SC-002 | `--dir` override | Custom directory is created and used correctly | Integration test |
| SC-003 | Browser auto-open | URL opens on macOS; URL printed on Linux | Manual test per platform |
| SC-004 | Error UX | All known failure modes produce actionable error messages | Unit tests for each error path |
| SC-005 | Cluster registry | Cluster appears in `generacy status` after launch | Integration test |
| SC-006 | Integration test | Passes against fixture cloud server and small fixture image | CI pipeline |

## Assumptions

- The `packages/cli` package does not yet exist and will be created as part of this feature (or a preceding scaffolding task).
- The cloud endpoint `GET /api/clusters/launch-config` may not be ready; a stubbed response is acceptable for initial implementation.
- The cluster image is published to GHCR (phase-6 dependency); image registry is configurable via environment variable for development.
- A local cluster registry mechanism exists or will be defined (for `generacy status` integration).

## Out of Scope

- Cloud-side implementation of the `/api/clusters/launch-config` endpoint (separate issue).
- Publishing the cluster image to GHCR (phase-6).
- The `generacy status` command itself (only the registry write is in scope).
- Cluster teardown / `generacy destroy` command.
- Multi-cluster management or cluster updates.

## Dependencies

- Cloud endpoint: `GET /api/clusters/launch-config?claim=<code>` (follow-up issue if not filed).
- GHCR cluster image variant (phase-6 dependency).
- Orchestrator activation flow (#492) — the activation URL the launch command watches for.

---

*Generated by speckit*
