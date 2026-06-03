# Tasks: Per-cluster tunnel name + identity for multi-cluster

**Input**: Design documents from `/specs/744-summary-cluster-cli/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Shared Foundation (helpers + schemas)

- [ ] T001 [P] [US1] Create name normalization helper at `packages/generacy/src/cli/commands/cluster/name-normalize.ts` exporting `normalizeClusterName(input: string, maxLen?: number)` and `sanitizeProjectComponent(input: string)`. Implement the algorithm from `research.md` §4 (lowercase → replace non-`[a-z0-9-]` runs with `-` → trim → truncate → `c-` prefix if not letter-initial → re-truncate). Default `maxLen=63` for cluster name, `40` for project component. Return `null` when result is empty.
- [ ] T002 [P] [US1] Add tests for normalization at `packages/generacy/src/cli/commands/cluster/__tests__/name-normalize.test.ts`. Cover: ASCII passthrough, mixed-case lowering, non-Latin scripts collapsing to `-`, digit-initial inputs gaining `c-` prefix, empty/whitespace returning `null`, truncation boundary (63 and 40), trailing-hyphen trim after truncation, and post-conditions matching `/^[a-z][a-z0-9-]{0,62}$/` (or `,39` for project).
- [ ] T003 [P] [US3] Extend `ClusterMetadata` interface and `ClusterMetadataSchema` in `packages/cluster-relay/src/messages.ts` with optional `displayName?: string` and `clusterId?: string` fields (additive only, per FR-007/FR-008 and `contracts/cluster-metadata.schema.json`).
- [ ] T004 [P] [US3] Extend `ClusterMetadataPayload` in `packages/orchestrator/src/types/relay.ts` with optional `displayName?: string` and `clusterId?: string` fields.
- [ ] T005 [P] [US4] Extend `LifecycleActionSchema` in `packages/control-plane/src/schemas.ts` with new `'vscode-tunnel-unregister'` enum entry (per `contracts/lifecycle-action.schema.json`).
- [ ] T006 [P] [US1] Extend `RegistryEntrySchema` in `packages/generacy/src/cli/commands/cluster/registry.ts` adding optional `displayName: z.string().optional()`, `projectId: z.string().optional()`, and `deploymentMode: z.enum(['local','cloud']).optional()` (per `contracts/registry-entry.schema.json`). Preserve `name` field for backward compat. No migration of existing entries.

## Phase 2: Default-name generator

- [ ] T007 [US1] Create default-name generator at `packages/generacy/src/cli/commands/cluster/default-name.ts` exporting `generateDefaultName(projectId: string, projectName: string, registry: Registry): string`. Filter registry by `projectId` and `(deploymentMode ?? 'local') === 'local'`, take normalized `displayName` set, return smallest `${sanitizeProjectComponent(projectName)}-local-${n}` not in the set. Depends on T001 (sanitize) and T006 (schema fields).
- [ ] T008 [US1] Add tests at `packages/generacy/src/cli/commands/cluster/__tests__/default-name.test.ts`. Cover: empty registry → `-local-1`, contiguous gaps (`1,2,4` → `3`), cross-project isolation, `deploymentMode='cloud'` entries ignored, missing-`deploymentMode` entries treated as `'local'`, missing-`projectId` entries excluded, project-name sanitization passthrough.

## Phase 3: Scaffolder + identity persistence

- [ ] T009 [US1] Update `packages/generacy/src/cli/commands/cluster/scaffolder.ts`: extend `ScaffoldClusterJsonInput` with `displayName?: string`; `scaffoldClusterJson()` writes `display_name` field to `.generacy/cluster.json` when present (per `contracts/cluster-json.schema.json`). Extend `ScaffoldEnvInput` (or compose-scaffolder input) with `clusterName?: string` and emit `GENERACY_CLUSTER_NAME=<name>` line into `.generacy/.env` when present.
- [ ] T010 [US1] Update `packages/generacy/src/cli/commands/cluster/context.ts` (or equivalent reader) to expose `display_name` from `cluster.json` in `ClusterContext`. Fall back to `cluster_id` when absent.

## Phase 4: CLI launch wiring

- [ ] T011 [US1] Extend `LaunchOptions` in `packages/generacy/src/cli/commands/launch/types.ts` with optional `name?: string`.
- [ ] T012 [US1] Update `packages/generacy/src/cli/commands/launch/index.ts`: add `.option('--name <name>', ...)` to the commander program; after fetching `LaunchConfig`, resolve `displayName = opts.name ? normalizeClusterName(opts.name) : generateDefaultName(launchConfig.projectId, launchConfig.projectName, readRegistry())`. Reject with clear error when `normalizeClusterName` returns `null`. Thread `displayName` into the scaffolder call. Depends on T001, T007, T009.
- [ ] T013 [US1] Update `packages/generacy/src/cli/commands/launch/registry.ts` to persist `displayName`, `projectId`, and `deploymentMode: 'local'` on the new registry entry. Depends on T006.

## Phase 5: CLI deploy wiring

- [ ] T014 [P] [US5] Extend `DeployOptions` in `packages/generacy/src/cli/commands/deploy/types.ts` with optional `name?: string`.
- [ ] T015 [US5] Update `packages/generacy/src/cli/commands/deploy/index.ts`: add `.option('--name <name>', ...)` to the commander program; normalize via `normalizeClusterName(opts.name)` when present, otherwise leave `displayName` undefined (falls back to cluster id per Q5→B). Reject on empty-normalization. Thread through scaffolder. Depends on T001, T009.
- [ ] T016 [US5] Update `packages/generacy/src/cli/commands/deploy/scaffolder.ts` to pass `displayName` and `deploymentMode: 'cloud'` through to the shared scaffolder + registry write. Depends on T006, T009.

## Phase 6: Control-plane tunnel-name source + lifecycle

- [ ] T017 [US2] Update `packages/control-plane/src/services/vscode-tunnel-manager.ts`: revert `loadOptionsFromEnv` to read `GENERACY_CLUSTER_ID` (not `GENERACY_PROJECT_ID` per #618). Update the comment on `deriveTunnelName` to record the ≤20 char / lowercase / `[a-z0-9-]` / letter-initial constraint and a one-line note that multi-cluster forces per-cluster derivation (FR-001/FR-002). Add a post-condition assertion matching `/^[a-z][a-z0-9-]{0,19}$/`.
- [ ] T018 [US4] In the same `vscode-tunnel-manager.ts`, add `unregister(): Promise<void>` that spawns `code tunnel unregister --name <tunnelName>` with a 10s timeout. Best-effort: timeout/non-zero exit emits `cluster.vscode-tunnel` warning event and resolves (does not throw). Depends on T017.
- [ ] T019 [US2] In `vscode-tunnel-manager.ts` `handleStdoutLine`, when `actualTunnelName` parsed from `vscode.dev/tunnel/<x>` differs from the requested name, emit a `cluster.vscode-tunnel` error event with `{requested, actual}` payload (FR-012). Observational only — does not abort the tunnel.
- [ ] T020 [US4] Add `vscode-tunnel-unregister` handler branch in `packages/control-plane/src/routes/lifecycle.ts`: look up `VsCodeTunnelManager`, call `unregister()`, return `{accepted: true, action: 'vscode-tunnel-unregister'}`. Failures surface via relay event, not 5xx (per FR-010). Depends on T005, T018.

## Phase 7: Orchestrator config + metadata

- [ ] T021 [US3] Update `packages/orchestrator/src/config/loader.ts` to read optional `GENERACY_CLUSTER_NAME` env var into the orchestrator config.
- [ ] T022 [US3] Update `packages/orchestrator/src/services/relay-bridge.ts` `collectMetadata()` to populate `displayName` (from config) and `clusterId` (from config) on the outgoing `ClusterMetadataPayload`. Depends on T004, T021.
- [ ] T023 [US3] Update `packages/cluster-relay/src/metadata.ts` `collectMetadata` (handshake/reconnect path) to forward `displayName` and `clusterId` when present in the orchestrator `/health` response or upstream metadata source. Depends on T003.

## Phase 8: CLI lifecycle teardown (stop/down/destroy)

- [ ] T024 [US4] Add `lifecycleAction(ctx, action, body?)` helper to `packages/generacy/src/cli/commands/cluster/compose.ts`. Wraps `docker compose exec orchestrator curl --unix-socket /run/generacy-control-plane/control.sock -X POST http://x/lifecycle/<action>`. Returns `{ok, status, body}`. 10s timeout. Swallows non-2xx and logs warning (best-effort).
- [ ] T025 [US4] Update `packages/generacy/src/cli/commands/stop/index.ts` to call `lifecycleAction(ctx, 'vscode-tunnel-stop')` before `docker compose stop`. Depends on T024.
- [ ] T026 [US4] Update `packages/generacy/src/cli/commands/down/index.ts` to call `lifecycleAction(ctx, 'vscode-tunnel-stop')` before `docker compose down` (preserve `--volumes` passthrough). Depends on T024.
- [ ] T027 [US4] Update `packages/generacy/src/cli/commands/destroy/index.ts` to call `lifecycleAction(ctx, 'vscode-tunnel-unregister')` before `docker compose down -v`. Depends on T024, T020.

## Phase 9: Integration tests + property tests

- [ ] T028 [P] [US2] Property test on `deriveTunnelName` in `packages/control-plane/src/services/__tests__/vscode-tunnel-manager.test.ts`: random UUID inputs always satisfy `/^[a-z][a-z0-9-]{0,19}$/` (SC-004). Add unit test for collision-error emission path (T019).
- [ ] T029 [P] [US1] Integration test for `generacy launch` scaffold: runs scaffolder with `--name "ACME Frontend"`, asserts `.generacy/cluster.json` contains `display_name: "acme-frontend"`, `.generacy/.env` contains `GENERACY_CLUSTER_NAME=acme-frontend` (SC-001).
- [ ] T030 [P] [US1] Integration test for default-name sequence: ten registry entries with the same `projectId` and `deploymentMode='local'` produce ten distinct names `-local-1`…`-local-10` (SC-002).
- [ ] T031 [P] [US1] Integration test interleaving `deploymentMode='local'` and `'cloud'` entries under one `projectId`: local sequence and cloud sequence remain independent and contiguous (SC-008).
- [ ] T032 [P] [US5] Unit test asserting `normalizeClusterName` produces identical output for the same input across `launch` and `deploy` code paths (SC-007).

## Dependencies & Execution Order

**Phase 1** (parallel-heavy foundation): T001–T006 are all independent (different files / different packages). T002 needs T001 logically but tests can be written in parallel since they target the same new module.

**Phase 2** depends on T001 (normalize) and T006 (registry schema).

**Phase 3** depends on T006 (schema knows the new fields).

**Phase 4** depends on T001, T007, T009, T006.

**Phase 5** depends on T001, T009, T006. Parallel with Phase 4 after deps land — different files, no shared state.

**Phase 6** is mostly isolated from CLI work and can run in parallel with Phase 4 and Phase 5 once T005 is in. T018 → T020 (handler needs the method); T017 is independent.

**Phase 7** depends on T003, T004. Parallel with Phase 4/5/6.

**Phase 8** depends on T024 (the shared helper), then T025/T026/T027 are sibling tasks. T027 additionally depends on T020.

**Phase 9** runs after the relevant implementation phases: T028 after Phase 6; T029/T030/T031 after Phase 4; T032 after Phase 5.

## Parallel Execution Opportunities

- **Wave 1 (start immediately)**: T001, T002, T003, T004, T005, T006 (six tasks, all [P]).
- **Wave 2**: T007 + T009 + T017 + T021 (different packages, no overlap).
- **Wave 3**: T011, T014 (option type extensions in launch/deploy in parallel).
- **Wave 4**: Phase 4 (T012, T013) and Phase 5 (T015, T016) and Phase 6 (T018, T019, T020) and Phase 7 (T022, T023) and Phase 8 (T024) — all touch different files; safe to fan out.
- **Wave 5**: T025, T026, T027 (different CLI command files).
- **Wave 6**: T028, T029, T030, T031, T032 (all [P]).

## Summary

- **Total tasks**: 32
- **Phases**: 9 (Foundation → Generator → Scaffolder → Launch → Deploy → Control-plane → Orchestrator → CLI teardown → Tests)
- **Parallel opportunities**: 6-wide initial wave, 5-wide test wave, plus mid-flight cross-package parallelism
- **User-story coverage**: US1 (launch + naming) 11 tasks, US2 (tunnel uniqueness) 4 tasks, US3 (identity in registration) 4 tasks, US4 (release on teardown) 6 tasks, US5 (deploy parity) 4 tasks

Next step: `/speckit:implement` to begin execution.
