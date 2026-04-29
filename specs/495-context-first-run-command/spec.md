# Feature Specification: CLI Launch Command (Claim-Code First-Run Flow)

**Branch**: `495-context-first-run-command` | **Date**: 2026-04-29 | **Status**: Draft

## Summary

Implement `npx generacy launch --claim=<code>` — the first-run command that bootstraps a brand-new cluster from a cloud-issued claim code. This is the primary onboarding entry point for cloud-flow users.

## Context

The first-run command. `npx generacy launch --claim=<code>` (or with no claim, prompts for one) bootstraps a brand-new cluster from a cloud-issued claim. Architecture: [docs/dev-cluster-architecture.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/dev-cluster-architecture.md) — "CLI design" and "Onboarding flow B".

## Scope

Implement `packages/generacy/src/cli/commands/launch/` (added to the existing CLI package, following the same pattern as `init` and other commands):

1. Validate Node version (already done by the CLI entry; reaffirm here for direct-import callers).
2. Validate Docker is reachable.
3. Read `--claim` arg or prompt for one.
4. Call `GET {GENERACY_CLOUD_URL}/api/clusters/launch-config?claim=<code>` — returns `{ projectId, projectName, variant, cloudUrl, clusterId, imageTag, repos: { primary, dev?, clone? } }`. Single round-trip with everything needed to scaffold. `clusterId` is cloud-generated (globally unique within org). `imageTag` is the specific GHCR tag (e.g., `ghcr.io/generacy-ai/cluster-base:1.5.0`). Use a stubbed response if the endpoint isn't yet ready and document the dependency.
5. Pick a project directory. Default `~/Generacy/<projectName>`. `--dir <path>` overrides. Confirm with the user before creating.
6. Write `.generacy/cluster.yaml` with the chosen variant image tag, port mappings, and cloud URL.
7. Write `.generacy/cluster.json` with cluster metadata (clusterId, projectId, etc.).
8. Write `.generacy/docker-compose.yml` that pulls the published cluster image variant from GHCR using the `imageTag` from the launch-config response.
9. `docker compose pull` + `docker compose up -d`.
10. Stream cluster logs until the activation URL is printed; match the `"Go to:"` line pattern to extract `verification_uri`, display the `user_code` prominently in CLI output, auto-open the URL in the user's default browser (`open` on macOS, `start` on Windows). On Linux, print the URL with clear "Open this in your browser" instructions.
11. Add the cluster to the registry at `~/.generacy/clusters.json` with entry shape `{clusterId, name, path, composePath, variant, channel, cloudUrl, lastSeen, createdAt}`.

## Acceptance Criteria

- Happy path from a clean directory boots a working cluster and opens the activation URL.
- `--dir` override works.
- Browser auto-open works on macOS/Windows; Linux fallback prints the URL.
- Failure to reach the cloud / pull the image / start compose all produce user-friendly errors with remediation hints.
- The cluster appears in `generacy status` after launch succeeds (reads from `~/.generacy/clusters.json`).
- Integration test against a fixture cloud server and a small fixture image.

## User Stories

### US1: First-Time Cloud Onboarding

**As a** developer joining a Generacy-powered project,
**I want** to run a single CLI command with my claim code,
**So that** a fully configured development cluster is bootstrapped locally without manual setup.

**Acceptance Criteria**:
- [ ] `npx generacy launch --claim=<code>` scaffolds the project directory, writes config files, and starts the cluster
- [ ] The activation URL opens automatically in the browser (macOS/Windows) or is printed clearly (Linux)
- [ ] The cluster is registered and visible via `generacy status`

### US2: Custom Directory Override

**As a** developer with a preferred workspace layout,
**I want** to specify a custom directory for the project,
**So that** the cluster files are created where I want them.

**Acceptance Criteria**:
- [ ] `--dir <path>` overrides the default `~/Generacy/<projectName>` location
- [ ] The user is prompted for confirmation before the directory is created

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Validate Node version >=20 | P1 | Reaffirm for direct-import callers |
| FR-002 | Validate Docker daemon is reachable | P1 | User-friendly error if not |
| FR-003 | Read `--claim` arg or interactively prompt | P1 | |
| FR-004 | Call `GET /api/clusters/launch-config?claim=<code>` | P1 | Returns full response: `{ projectId, projectName, variant, cloudUrl, clusterId, imageTag, repos }` |
| FR-005 | Determine project directory (default `~/Generacy/<projectName>`, `--dir` override) | P1 | Confirm with user before creating |
| FR-006 | Write `.generacy/cluster.yaml` | P1 | Variant, image tag, port mappings, cloud URL |
| FR-007 | Write `.generacy/cluster.json` | P1 | Cluster metadata from launch-config response |
| FR-008 | Write `.generacy/docker-compose.yml` | P1 | Uses `imageTag` from launch-config |
| FR-009 | `docker compose pull` + `docker compose up -d` | P1 | |
| FR-010 | Stream logs, match `"Go to:"` pattern, extract `verification_uri`, display `user_code` | P1 | Auto-open on macOS/Windows, print on Linux |
| FR-011 | Register cluster in `~/.generacy/clusters.json` | P1 | Schema: `{clusterId, name, path, composePath, variant, channel, cloudUrl, lastSeen, createdAt}` |
| FR-012 | Stub launch-config response if endpoint not ready | P2 | Document the dependency |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Happy-path completion | <60s from command to activation URL | Manual timing on standard connection |
| SC-002 | Error coverage | All failure modes produce remediation hints | Review error paths in code |
| SC-003 | Cross-platform browser open | Works on macOS, Windows, Linux (fallback) | Manual test per platform |

## Assumptions

- The existing CLI package at `packages/generacy/src/cli/` uses Commander.js and the `launch` command follows the same directory pattern as `init`.
- `launch` is standalone — it does NOT invoke or depend on the `init` command. Convergence can come in a later release.
- The `~/.generacy/clusters.json` registry format is defined by #494; this issue consumes it.
- The claim-code identifies the project to the cloud's launch-config endpoint. Cluster activation still uses the device-code flow (RFC 8628) on first boot.
- The cloud endpoint may not exist yet; a stub implementation is acceptable with documented dependency.

## Out of Scope

- Reusing or invoking the `init` command's scaffolding logic (convergence deferred).
- Pre-approving the device-code server-side using the claim (future enhancement beyond v1.5).
- Defining the `~/.generacy/clusters.json` registry schema (owned by #494).
- The `generacy status` command itself (owned by #494).
- Creating a separate `packages/cli` package.

---

*Generated by speckit*
