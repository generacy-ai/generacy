# Feature Specification: Reconcile launch CLI schemas with lifecycle commands

**Branch**: `518-context-launch-command-writes` | **Date**: 2026-04-30 | **Status**: Draft

## Summary

The `launch` command writes `cluster.json` and `~/.generacy/clusters.json` using schemas incompatible with the lifecycle commands (`up`, `stop`, `down`, etc.), causing `generacy up` after `npx generacy launch` to fail Zod validation with "Cluster configuration is corrupted". This spec covers reconciling the schemas, adding a missing `orgId` field to `LaunchConfig`, unifying registry write/read paths, and fixing the Node version gate.

## Context

The `launch` command writes data using one schema (camelCase, missing fields); the lifecycle commands (`up`, `stop`, `down`, etc.) read with a different schema (snake_case, requires `org_id`). Result: `generacy up` after `npx generacy launch` fails Zod validation with "Cluster configuration is corrupted" — local launch flow is fully broken.

## Files

- `packages/generacy/src/cli/commands/launch/scaffolder.ts:72-86` — writes camelCase fields including `clusterId`, `cloudUrl`, `projectName`, `imageTag`; missing `org_id`, `activated_at`.
- `packages/generacy/src/cli/commands/deploy/scaffolder.ts` — identical bugs to launch scaffolder (camelCase `cluster.json`, excess fields in `cluster.yaml`).
- `packages/generacy/src/cli/commands/cluster/context.ts:17-23` — reads snake_case fields; expects `cluster_id`, `project_id`, `org_id`, `cloud_url`, `activated_at`.
- `packages/generacy/src/cli/commands/launch/types.ts:18-30` — `LaunchConfigSchema` doesn't include `orgId` (needed for cluster.json).
- `packages/generacy/src/cli/commands/launch/registry.ts` — writes plain object; `cluster/registry.ts` reads via Zod with stricter enums.
- `packages/generacy/src/cli/commands/launch/index.ts:48` — Node version check is `>= 20`; `package.json` engines says `>= 22`.

## Fix

1. **cluster.json schema**: standardize on snake_case (matches the orchestrator's `/var/lib/generacy/cluster.json` schema). Update both `launch/scaffolder.ts` and `deploy/scaffolder.ts` to write `cluster_id`, `project_id`, `org_id`, `cloud_url`. Omit `activated_at` (optional, populated post-activation). Remove unused `projectName`, `imageTag` from the persisted file.
2. **LaunchConfigSchema**: add `orgId: z.string().min(1)` (required — forces deploy ordering with companion cloud issue #474).
3. **cluster.yaml schema**: remove excess fields (`imageTag`, `cloudUrl`, `ports`) from both launch and deploy scaffolders. `cluster.yaml` contains only `{channel, workers, variant}`. `imageTag`/`ports` go to `docker-compose.yml`; `cloudUrl` goes to `cluster.json`.
4. **Registry schema**: define schema once in `cluster/registry.ts`; export `RegistryEntry`; import in `launch/registry.ts` and validate before writing. Strict enums for `variant` (`cluster-base` | `cluster-microservices`) and `channel` (`stable` | `preview`). `clusterId` remains nullable.
5. **Deploy scaffolder**: apply all fixes identically to `deploy/scaffolder.ts`. Extract shared scaffolder helper for both commands.
6. **Node version check**: `>= 22` in `launch/index.ts:48`; update error message.

## Background

Originals: #494, #495. Per clarifications, the cluster.json schema mirrors the container's `/var/lib/generacy/cluster.json` (snake_case); registry is the rich schema from #494-Q3; Node 22+ from #493.

## User Stories

### US1: Developer runs launch then up without errors

**As a** developer onboarding a new project,
**I want** `npx generacy launch --claim=<code>` followed by `generacy up` to succeed without validation errors,
**So that** the cloud-flow onboarding works end-to-end as documented.

**Acceptance Criteria**:
- [ ] `launch` writes `cluster.json` in the snake_case schema expected by lifecycle commands
- [ ] `generacy up` reads `cluster.json` without Zod validation failure
- [ ] No "Cluster configuration is corrupted" error in the launch-then-up flow

### US2: Registry consistency across commands

**As a** developer managing multiple clusters,
**I want** `generacy launch` and `generacy status` to share the same registry schema,
**So that** `generacy status` correctly lists clusters created via `launch`.

**Acceptance Criteria**:
- [ ] `launch` validates registry entries against the shared Zod schema before writing
- [ ] `generacy status` lists clusters created by `launch` without parse errors
- [ ] `variant` and `channel` fields use strict enum validation

### US3: Node version gate matches package.json

**As a** developer on Node 20,
**I want** `generacy launch` to refuse with a clear error pointing to Node 22+,
**So that** I don't encounter cryptic runtime errors from unsupported Node features.

**Acceptance Criteria**:
- [ ] `launch` exits with a user-friendly error on Node < 22
- [ ] Error message includes install instructions link (consistent with `checkNodeVersion()` from #493)

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `launch/scaffolder.ts` writes `cluster.json` with snake_case keys: `cluster_id`, `project_id`, `org_id`, `cloud_url`, `activated_at` | P0 | Matches orchestrator schema |
| FR-002 | Remove `projectName` and `imageTag` from persisted `cluster.json` (not consumed by any reader) | P1 | Reduces schema drift |
| FR-003 | Add `orgId: z.string().min(1)` to `LaunchConfigSchema` in `launch/types.ts` | P0 | Required for `org_id` in cluster.json |
| FR-004 | Export `RegistryEntrySchema` from `cluster/registry.ts`; import and validate in `launch/registry.ts` | P1 | Single source of truth |
| FR-005 | Use strict Zod enums for `variant` and `channel` in the shared registry schema | P1 | Prevents invalid values |
| FR-006 | Update Node version check in `launch/index.ts` from `>= 20` to `>= 22` | P1 | Matches `package.json` engines |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Launch-then-up flow | Zero validation errors | Manual and integration test of `launch` followed by `up` |
| SC-002 | Schema consistency | cluster.json matches between writer and reader | Unit test parsing launch output with lifecycle reader schema |
| SC-003 | Registry round-trip | `generacy status` lists launch-created clusters | Integration test of `launch` then `status` |
| SC-004 | Node gate accuracy | Rejects Node 20, accepts Node 22+ | Unit test of version check |

## Assumptions

- The cloud-side `/api/clusters/launch-config` endpoint will be updated to include `orgId` in its response (companion cloud issue).
- The orchestrator's `/var/lib/generacy/cluster.json` is the canonical snake_case schema reference.
- No existing users depend on the current camelCase `cluster.json` format (this is a v1.5 pre-release fix).

## Out of Scope

- Convergence of `launch` and `init` commands (deferred per #495 spec).
- ~~Changes to `cluster.yaml` schema~~ — now in scope per Q3: remove excess fields from launch/deploy scaffolders.
- Cloud-side endpoint changes (tracked in companion issue).
- Migration tooling for existing `cluster.json` files (none exist in production yet).

---

*Generated by speckit*
