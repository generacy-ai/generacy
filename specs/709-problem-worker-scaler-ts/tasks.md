# Tasks: Decouple worker-scaler runtime state from git-tracked cluster.yaml

**Input**: Design documents from `/specs/709-problem-worker-scaler-ts/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = the bugfix as a whole; the spec is single-story)

## Phase 1: Shared merged-read helper (`@generacy-ai/config`)

- [X] T001 [US1] Create `packages/config/src/cluster-config-schema.ts` defining `ClusterYamlSchema` (zod, `.passthrough()`, fields: `channel`, `workers`, `variant`, `appConfig` as `z.unknown().optional()`) and `ClusterLocalYamlSchema` (zod, `.passthrough()`, `workers` only for now). Export inferred types `ClusterYamlData` and `ClusterLocalYamlData`. Shape per `data-model.md`.
- [X] T002 [US1] Create `packages/config/src/cluster-config.ts` implementing `readMergedClusterConfig(generacyDir: string): Promise<MergedClusterConfig>`. Reads both `.generacy/cluster.yaml` and `.generacy/cluster.local.yaml` via `node:fs/promises`, parses with `yaml`, validates with the schemas from T001. ENOENT → `{}`; malformed YAML on either file → throw with file path in the message. Returns `{ merged, canonical, local }` with shallow per-top-level-key merge (local wins).
- [X] T003 [US1] Add exports for `readMergedClusterConfig`, `MergedClusterConfig`, `ClusterYamlData`, `ClusterLocalYamlData`, `ClusterYamlSchema`, `ClusterLocalYamlSchema` from `packages/config/src/index.ts`.
- [X] T004 [P] [US1] Add unit tests in `packages/config/__tests__/cluster-config.test.ts` covering: both files missing → empty merged; canonical-only → equals canonical; local-only → equals local; disjoint keys → union; overlapping `workers` → local wins; malformed canonical YAML → throws; malformed local YAML → throws.
- [X] T005 [P] [US1] Build + test `@generacy-ai/config`: `pnpm --filter @generacy-ai/config build test`. Confirm green before any downstream package adopts the helper.

## Phase 2: Migrate worker-scaler write path

- [X] T006 [US1] Add `"@generacy-ai/config": "workspace:*"` to `packages/control-plane/package.json` dependencies. Run `pnpm install` so the workspace link resolves.
- [X] T007 [US1] In `packages/control-plane/src/services/worker-scaler.ts`, add `updateClusterLocalYaml(localYamlPath, count)` — mirrors the existing `updateClusterYaml` atomic temp+rename pattern but reads/writes `cluster.local.yaml`. Permissive YAML parse with `{}` fallback on empty/missing file. Preserves any other top-level fields already present in the file.
- [X] T008 [US1] In `packages/control-plane/src/services/worker-scaler.ts`, replace the `updateClusterYaml(yamlPath, actualCount)` call inside `doScale()` with `updateClusterLocalYaml(join(generacyDir, 'cluster.local.yaml'), actualCount)`. Verify no other callers via grep; delete the now-unused `updateClusterYaml` export and its implementation.
- [X] T009 [US1] Update `packages/control-plane/__tests__/services/worker-scaler.test.ts`: move post-scale fixture assertions from `cluster.yaml` to `cluster.local.yaml`. Add a negative-assertion test: `cluster.yaml` content is byte-identical (or absent) pre- and post-scale, proving no write to the git-tracked file.

## Phase 3: Migrate relay-bridge read path

- [X] T010 [US1] In `packages/orchestrator/src/services/relay-bridge.ts` (lines ~608–623), replace the body of `readClusterYaml()` with a call to `readMergedClusterConfig(dirname(this.config.clusterYamlPath))`. Return `{ workers: merged.workers, channel: merged.channel }` (existing return shape). Mark method `async`; await it from `collectMetadata()` / `sendMetadata()` (already async per #596).
- [X] T011 [US1] Update `packages/orchestrator/src/services/__tests__/relay-bridge.test.ts` and `relay-bridge-metadata.test.ts`: extend fixtures to write both `cluster.yaml` and `cluster.local.yaml`. Existing "reads workers from yaml" tests keep passing; add a new test asserting `cluster.local.yaml workers:` overrides `cluster.yaml workers:` in the metadata payload.

## Phase 4: Migrate app-config read path

- [ ] T012 [US1] In `packages/control-plane/src/routes/app-config.ts` (lines ~42–61), replace the `readManifest()` body with `readMergedClusterConfig(await resolveGeneracyDir())`, then validate `merged.appConfig` with the existing `AppConfigSchema`. Preserve ENOENT → `null` behavior when `appConfig` is absent from both files.
- [ ] T013 [US1] Update `packages/control-plane/__tests__/routes/app-config.test.ts`: existing fixtures (only `cluster.yaml`) keep passing. Add a regression test where `cluster.local.yaml` exists but lacks `appConfig` — `readManifest()` must still return the canonical `appConfig` unchanged.

## Phase 5: Cross-cutting checks

- [ ] T014 [US1] Grep `packages/control-plane/src` and `packages/orchestrator/src` for any remaining direct `cluster.yaml` reads (`readFile.*cluster\.yaml`, `parseYaml.*cluster`, etc.). Migrate any not covered in T010 / T012 onto `readMergedClusterConfig`, or document in this task why they should not be (e.g. CLI-side template parsing in `packages/generacy/src/cli/commands/cluster/context.ts` is host-side, out of scope per plan).
- [ ] T015 [US1] Run full build + test on all affected packages in order: `pnpm --filter @generacy-ai/config build test` → `pnpm --filter @generacy-ai/control-plane build test` → `pnpm --filter @generacy-ai/orchestrator build test`. All green.
- [ ] T016 [US1] Manual verification per `quickstart.md`: trigger a worker-scale via control-plane Unix socket, confirm `git status` is clean, `cluster.yaml` content unchanged, `cluster.local.yaml` written with new count, cloud-UI merged read reflects new count. Document any deviation in the PR description.

## Dependencies & Execution Order

**Phase boundaries (sequential):**
- Phase 1 must complete before Phase 2/3/4 (downstream packages can't depend on the helper until it builds).
- Phase 5 runs last (it validates the cumulative state).

**Within Phase 1 (sequential then parallel):**
- T001 → T002 (schemas before helper).
- T002 → T003 (export after implementation).
- T004 [P] depends on T002 (tests target the helper) but can be written in parallel with T003.
- T005 must come after T001–T004 (validates the package builds + tests pass).

**Phases 2/3/4 can run in parallel** once Phase 1 is green:
- Phase 2 (T006 → T007 → T008 → T009) is sequential within itself, but Phase 3 (T010 → T011) and Phase 4 (T012 → T013) touch different files and can run alongside Phase 2.
- T006 (control-plane dep add) blocks T007–T009 and T012–T013 (control-plane edits need the workspace link).

**Phase 5:**
- T014 must come after T008/T010/T012 (it's the cross-cutting grep + migration cleanup).
- T015 must come after T014 (final build/test sweep).
- T016 must come after T015 (manual verify needs a green build).

**Parallel opportunities:**
- T004, T005 can be drafted alongside T003.
- After T006, the three migrate-phases (Phase 2 from T007 onward, Phase 3, Phase 4) can run in parallel.
- T009, T011, T013 (test updates) can all run in parallel once their source-file edits land.

## Suggested Next Step

`/speckit:implement` to execute the task list.
