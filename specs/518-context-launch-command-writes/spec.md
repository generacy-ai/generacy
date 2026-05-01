# Feature Specification: Reconcile launch CLI schemas with lifecycle commands

**Branch**: `518-context-launch-command-writes` | **Date**: 2026-05-01 | **Status**: Draft

## Summary

The `launch` command writes config files (`cluster.json`, registry entries) using a different schema than the lifecycle commands (`up`, `stop`, `down`, etc.) expect to read. This causes `generacy up` after `npx generacy launch` to fail Zod validation with "Cluster configuration is corrupted" — the local launch flow is fully broken. This fix reconciles the schemas so launch writes match what lifecycle reads.

## Context

The `launch` command writes data using one schema (camelCase, missing fields); the lifecycle commands (`up`, `stop`, `down`, etc.) read with a different schema (snake_case, requires `org_id`). Result: `generacy up` after `npx generacy launch` fails Zod validation with "Cluster configuration is corrupted" — local launch flow is fully broken.

## Files

- `packages/generacy/src/cli/commands/launch/scaffolder.ts:72-86` — writes camelCase fields including `clusterId`, `cloudUrl`, `projectName`, `imageTag`; missing `org_id`, `activated_at`.
- `packages/generacy/src/cli/commands/cluster/context.ts:17-23` — reads snake_case fields; expects `cluster_id`, `project_id`, `org_id`, `cloud_url`, `activated_at`.
- `packages/generacy/src/cli/commands/launch/types.ts:18-30` — `LaunchConfigSchema` doesn't include `orgId` (needed for cluster.json).
- `packages/generacy/src/cli/commands/launch/registry.ts` — writes plain object; `cluster/registry.ts` reads via Zod with stricter enums.
- `packages/generacy/src/cli/commands/launch/index.ts:48` — Node version check is `>= 20`; `package.json` engines says `>= 22`.

## Fix

1. **cluster.json schema**: standardize on snake_case (matches the orchestrator's `/var/lib/generacy/cluster.json` schema). Update `launch/scaffolder.ts` to write `cluster_id`, `project_id`, `org_id`, `cloud_url`, `activated_at`. Remove unused `projectName`, `imageTag` from the persisted file.
2. **LaunchConfigSchema**: add `orgId: z.string().min(1)`. Verify the cloud-side `/api/clusters/launch-config` endpoint returns it (cross-ref companion cloud issue).
3. **Registry schema**: define schema once in `cluster/registry.ts`; export `RegistryEntry`; import in `launch/registry.ts` and validate before writing. Strict enums for `variant` and `channel`.
4. **Node version check**: `>= 22` in `launch/index.ts:48`; update error message.

## User Stories

### US1: Developer launches and manages a cluster without errors

**As a** developer using Generacy for the first time,
**I want** `npx generacy launch` to write config files that `generacy up/stop/down` can read,
**So that** the onboarding flow works end-to-end without "configuration is corrupted" errors.

**Acceptance Criteria**:
- [ ] `npx generacy launch --claim=<code>` writes `cluster.json` with snake_case keys matching lifecycle reader expectations
- [ ] `generacy up` succeeds immediately after launch without manual file edits
- [ ] `generacy status` lists the launched cluster correctly

### US2: Developer gets clear Node version feedback

**As a** developer on Node 20,
**I want** the launch command to refuse with a clear error pointing to Node 22+,
**So that** I know exactly what to upgrade before proceeding.

**Acceptance Criteria**:
- [ ] `npx generacy launch` on Node 20 exits with error message referencing Node >= 22
- [ ] Error message includes install/upgrade instructions link

### US3: Registry entries are validated consistently

**As a** developer running `generacy status` after launch,
**I want** the registry entry written by launch to match the schema read by lifecycle commands,
**So that** cluster listing and management commands work without validation errors.

**Acceptance Criteria**:
- [ ] Launch writes registry entries validated against the shared `RegistryEntrySchema`
- [ ] `generacy status` displays the cluster without Zod parse errors
- [ ] `variant` and `channel` fields use strict enum values

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `launch/scaffolder.ts` writes `cluster.json` with snake_case keys: `cluster_id`, `project_id`, `org_id`, `cloud_url`, `activated_at` | P0 | Matches orchestrator's `/var/lib/generacy/cluster.json` |
| FR-002 | `LaunchConfigSchema` includes `orgId: z.string().min(1)` | P0 | Required for `org_id` in cluster.json |
| FR-003 | Remove unused `projectName`, `imageTag` from persisted `cluster.json` | P1 | These are runtime-only values |
| FR-004 | Shared `RegistryEntrySchema` in `cluster/registry.ts` used by both launch and lifecycle commands | P0 | Single source of truth |
| FR-005 | `variant` enum restricted to `'cluster-base' | 'cluster-microservices'` | P1 | Matches GHCR image names |
| FR-006 | Node version gate updated to `>= 22` in `launch/index.ts` | P1 | Aligns with `package.json` engines |
| FR-007 | Shared scaffolder extracted to `cluster/scaffolder.ts` for use by both launch and deploy | P2 | DRY between launch and deploy commands |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Launch-to-up flow | Zero Zod validation errors | Manual test: `launch --claim` then `up` |
| SC-002 | Schema consistency | cluster.json writer/reader use identical Zod schema | Code review: single schema import |
| SC-003 | Registry consistency | Launch registry entries pass lifecycle validation | `generacy status` after `generacy launch` |
| SC-004 | Node version gate | Blocks Node < 22 | Test on Node 20 |

## Acceptance Criteria

- `npx generacy launch` followed by `generacy up` succeeds end-to-end without "configuration is corrupted" error.
- `cluster.json` schema matches between launch (writer) and lifecycle (reader); both use snake_case.
- Launch refuses to run on Node 20 with a clear error pointing at Node 22+ install instructions.
- `~/.generacy/clusters.json` registry validates cleanly after launch writes; `generacy status` lists the new cluster.
- Integration test exercises launch -> up -> stop on a fixture cluster.

## Assumptions

- The cloud-side `/api/clusters/launch-config` endpoint will be updated to return `orgId` (companion cloud issue).
- The orchestrator's `/var/lib/generacy/cluster.json` snake_case schema is the canonical format.
- `activated_at` is optional in cluster.json (populated container-side post-activation, not at launch time).

## Out of Scope

- Convergence of `launch` and `init` commands (deferred per #495).
- Cloud-side API changes (tracked in companion issue).
- Migration tooling for clusters created with the old camelCase schema.

## Background

Originals: #494, #495. Per clarifications, the cluster.json schema mirrors the container's `/var/lib/generacy/cluster.json` (snake_case); registry is the rich schema from #494-Q3; Node 22+ from #493.

---

*Generated by speckit*
