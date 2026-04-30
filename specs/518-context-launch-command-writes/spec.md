# Feature Specification: Reconcile launch CLI schemas with lifecycle commands

**Branch**: `518-context-launch-command-writes` | **Date**: 2026-04-30 | **Status**: Draft

## Summary

Reconcile schema mismatches between the `launch` command (writer) and lifecycle commands (reader) so that `npx generacy launch` followed by `generacy up` works end-to-end without Zod validation errors.

## Context

The `launch` command writes data using one schema (camelCase, missing fields); the lifecycle commands (`up`, `stop`, `down`, etc.) read with a different schema (snake_case, requires `org_id`). Result: `generacy up` after `npx generacy launch` fails Zod validation with "Cluster configuration is corrupted" — local launch flow is fully broken.

## Files

- `packages/generacy/src/cli/commands/launch/scaffolder.ts:72-86` — writes camelCase fields including `clusterId`, `cloudUrl`, `projectName`, `imageTag`; missing `org_id`, `activated_at`.
- `packages/generacy/src/cli/commands/cluster/context.ts:17-23` — reads snake_case fields; expects `cluster_id`, `project_id`, `org_id`, `cloud_url`, `activated_at`.
- `packages/generacy/src/cli/commands/launch/types.ts:18-30` — `LaunchConfigSchema` doesn't include `orgId` (needed for cluster.json).
- `packages/generacy/src/cli/commands/launch/registry.ts` — writes plain object; `cluster/registry.ts` reads via Zod with stricter enums.
- `packages/generacy/src/cli/commands/launch/index.ts:48` — Node version check is `>= 20`; `package.json` engines says `>= 22`.

## Fix

1. **cluster.json schema**: standardize on snake_case (matches the orchestrator's `/var/lib/generacy/cluster.json` schema). Update `launch/scaffolder.ts` to write `cluster_id`, `project_id`, `org_id`, `cloud_url`. Omit `activated_at` (optional — see Q1). Remove unused `projectName`, `imageTag` from the persisted file.
2. **LaunchConfigSchema**: add `orgId: z.string().min(1)` (required — see Q2). Cloud-side `/api/clusters/launch-config` endpoint must return it (companion issue #474, both `v1.5/blocker`).
3. **cluster.yaml schema**: remove `imageTag`, `cloudUrl`, `ports` from launch's cluster.yaml output (see Q3). These belong in `docker-compose.yml` and `cluster.json` respectively. `cluster.yaml` stays as project-level config (`channel, workers, variant`).
4. **Registry schema**: define schema once in `cluster/registry.ts`; export `RegistryEntry`; import in `launch/registry.ts` and validate before writing. Keep strict enums (see Q4). **Rename variant values** from `'standard' | 'microservices'` to `'cluster-base' | 'cluster-microservices'` to match architecture doc and GHCR image repo names. Keep `clusterId` nullable (see Q5).
5. **Node version check**: `>= 22` in `launch/index.ts:48`; update error message.

## Acceptance criteria

- `npx generacy launch` followed by `generacy up` succeeds end-to-end without "configuration is corrupted" error.
- `cluster.json` schema matches between launch (writer) and lifecycle (reader); both use snake_case. `activated_at` is optional.
- `orgId` is required in `LaunchConfigSchema`; launch fails with a clear error if cloud doesn't provide it.
- `cluster.yaml` written by launch contains only `channel`, `workers`, `variant` — no `imageTag`/`cloudUrl`/`ports`.
- Registry variant enum uses `'cluster-base' | 'cluster-microservices'`; `clusterId` is nullable.
- Launch refuses to run on Node 20 with a clear error pointing at Node 22+ install instructions.
- `~/.generacy/clusters.json` registry validates cleanly after launch writes; `generacy status` lists the new cluster.
- Integration test exercises launch → up → stop on a fixture cluster.

## Background

Originals: #494, #495. Per clarifications, the cluster.json schema mirrors the container's `/var/lib/generacy/cluster.json` (snake_case); registry is the rich schema from #494-Q3; Node 22+ from #493.

## User Stories

### US1: Developer launches and manages a cluster

**As a** developer using Generacy for the first time,
**I want** `npx generacy launch` to produce config files that `generacy up/stop/down` can read without errors,
**So that** I can bootstrap and manage my cluster without manual config fixes.

**Acceptance Criteria**:
- [ ] `npx generacy launch --claim=<code>` writes valid `cluster.json` (snake_case) and `cluster.yaml` (project config only)
- [ ] `generacy up` succeeds immediately after launch without Zod validation errors
- [ ] `generacy status` shows the launched cluster in the registry

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `launch/scaffolder.ts` writes `cluster.json` with snake_case keys (`cluster_id`, `project_id`, `org_id`, `cloud_url`); `activated_at` omitted | P1 | Matches lifecycle reader schema |
| FR-002 | `LaunchConfigSchema` adds `orgId: z.string().min(1)` as required field | P1 | Companion cloud issue #474 |
| FR-003 | `launch/scaffolder.ts` writes `cluster.yaml` with only `channel`, `workers`, `variant`; image/port/url fields go to `docker-compose.yml` or `cluster.json` | P1 | Q3 decision |
| FR-004 | Registry schema defined once in `cluster/registry.ts` with variant enum `'cluster-base' \| 'cluster-microservices'`; imported by `launch/registry.ts` | P1 | Q4 decision |
| FR-005 | `ClusterJsonSchema` makes `activated_at` optional (`.optional()` or `.nullable()`) | P1 | Q1 decision |
| FR-006 | Registry `clusterId` remains `z.string().nullable()` | P2 | Q5 decision |
| FR-007 | Node version check in `launch/index.ts` changed from `>= 20` to `>= 22` | P1 | Matches `package.json` engines |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | launch → up flow | Zero Zod validation errors | Integration test |
| SC-002 | Schema consistency | Single source of truth for cluster.json, cluster.yaml, and registry schemas | Code review |
| SC-003 | Node version gate | Refuses Node 20 with clear message | Unit test |

## Assumptions

- Cloud-side companion issue #474 ships together with this PR (both `v1.5/blocker`)
- Cloud `launch-config` endpoint returns `orgId` by the time this PR is tested
- Architecture-doc variant names (`cluster-base`, `cluster-microservices`) are canonical

## Out of Scope

- Cloud-side changes to `/api/clusters/launch-config` (tracked in #474)
- `init` command schema alignment (separate issue)
- Convergence of `launch` and `init` commands (deferred)

---

*Generated by speckit*
