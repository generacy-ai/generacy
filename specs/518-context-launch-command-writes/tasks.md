# Tasks: Reconcile launch CLI schemas with lifecycle commands

**Input**: Design documents from `/specs/518-context-launch-command-writes/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema Fixes

- [ ] T001 [US1] Fix `ClusterJsonSchema` in `cluster/context.ts`: make `activated_at` optional (`z.string().datetime().optional()`) at line 22
- [ ] T002 [P] [US1] Fix `ClusterYamlSchema` variant enum in `cluster/context.ts`: rename `'standard' | 'microservices'` → `'cluster-base' | 'cluster-microservices'` at line 12
- [ ] T003 [P] [US2] Fix `RegistryEntrySchema` variant enum in `cluster/registry.ts`: rename `'standard' | 'microservices'` → `'cluster-base' | 'cluster-microservices'` at line 13
- [ ] T004 [P] [US1] Add `orgId: z.string().min(1)` to `LaunchConfigSchema` in `launch/types.ts` after line 23; remove local `ClusterMetadata`, `ClusterYaml`, `ClusterRegistryEntry` interfaces

## Phase 2: Shared Scaffolder

- [ ] T005 [US1] Create shared scaffolder at `packages/generacy/src/cli/commands/cluster/scaffolder.ts` — export `scaffoldClusterJson(dir, input)`, `scaffoldClusterYaml(dir, input)`, `scaffoldDockerCompose(dir, input)` using snake_case `cluster.json` schema and minimal `cluster.yaml` (`{channel, workers, variant}` only)
- [ ] T006 [US1] Rewire `launch/scaffolder.ts` to delegate to shared `cluster/scaffolder.ts` — map `LaunchConfig` fields (`clusterId` → `cluster_id`, `projectId` → `project_id`, `orgId` → `org_id`, `cloudUrl` → `cloud_url`); remove excess `cluster.yaml` fields (`imageTag`, `cloudUrl`, `ports`)
- [ ] T007 [P] [US1] Rewire `deploy/scaffolder.ts` to delegate to shared `cluster/scaffolder.ts` — map `ActivationResult` fields to snake_case; remove excess `cluster.yaml` fields

## Phase 3: Registry Unification

- [ ] T008 [US2] Rewire `launch/registry.ts` to import and validate entries against `RegistryEntrySchema` from `cluster/registry.ts` before writing (or eliminate `launch/registry.ts` and call shared registry directly)
- [ ] T009 [US2] Fix `launch/index.ts` registry call (around line 190-209): build entry matching `RegistryEntrySchema` with `variant: 'cluster-base' | 'cluster-microservices'`, `channel: 'stable'`
- [ ] T010 [P] [US2] Fix `deploy/index.ts` registry entry construction (lines 79-90): use correct variant enum values, validate against `RegistryEntrySchema`

## Phase 4: Node Version Gate

- [ ] T011 [US3] Fix `launch/index.ts` Node version check: replace inline `validateNodeVersion()` (line 47-50) with `checkNodeVersion(22)` from `src/cli/utils/node-version.ts`; remove old function and error message at line 90

## Phase 5: Tests

- [ ] T012 [US1] Add unit tests for shared scaffolder: verify `cluster.json` output is snake_case with correct fields, `cluster.yaml` has only `{channel, workers, variant}`, variant enum values are `cluster-base`/`cluster-microservices`
- [ ] T013 [P] [US2] Add unit tests for registry round-trip: launch-created entries pass `RegistryEntrySchema` validation, variant/channel enums enforced
- [ ] T014 [P] [US1] Add unit test for launch→up flow: scaffold output from `launch/scaffolder.ts` parses cleanly against `ClusterJsonSchema` from `cluster/context.ts`

## Dependencies & Execution Order

**Phase 1** (T001-T004): All independent — run in parallel. These fix schemas that later phases depend on.

**Phase 2** (T005-T007): T005 (create shared scaffolder) must complete first. Then T006 and T007 can run in parallel (different files).

**Phase 3** (T008-T010): T008 must complete before T009 (launch registry depends on shared schema wiring). T010 (deploy) is independent of T009 and can run in parallel.

**Phase 4** (T011): Independent of Phase 3, but logically after Phase 1 (same file touched in T004).

**Phase 5** (T012-T014): All tests depend on Phase 2 completion. T012, T013, T014 can run in parallel.

**Critical path**: T001-T004 → T005 → T006 → T008 → T009 → T012
