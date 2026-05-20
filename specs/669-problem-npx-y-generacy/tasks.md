# Tasks: Fix `workspace:^` leak in published orchestrator package

**Input**: Design documents from `/specs/669-problem-npx-y-generacy/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Root Cause Investigation & Pipeline Fix

- [ ] T001 [US1] Investigate Changesets + pnpm publish interaction — run `pnpm publish --dry-run` on orchestrator locally and inspect the tarball to confirm `workspace:^` rewrite behavior from workspace root
- [ ] T002 [US1] Review `.github/workflows/release.yml` for workspace context issues — verify `changesets/action@v1` runs publish from workspace root with full pnpm context

## Phase 2: Guardrail Script & Package Updates

- [ ] T003 [US1] Create `scripts/check-workspace-deps.js` — plain Node.js script that reads `./package.json`, scans `dependencies`/`peerDependencies`/`optionalDependencies` for `workspace:` prefixed values, exits non-zero with violation list if found
- [ ] T004 [P] [US1] Add `prepublishOnly` script to `packages/activation-client/package.json` — `"prepublishOnly": "node ../../scripts/check-workspace-deps.js"`
- [ ] T005 [P] [US1] Add `prepublishOnly` script to `packages/cluster-relay/package.json`
- [ ] T006 [P] [US1] Add `prepublishOnly` script to `packages/config/package.json`
- [ ] T007 [P] [US1] Add `prepublishOnly` script to `packages/control-plane/package.json`
- [ ] T008 [P] [US1] Add `prepublishOnly` script to `packages/credhelper/package.json`
- [ ] T009 [P] [US1] Add `prepublishOnly` script to `packages/credhelper-daemon/package.json`
- [ ] T010 [P] [US1] Add `prepublishOnly` script to `packages/generacy/package.json`
- [ ] T011 [P] [US1] Add `prepublishOnly` script to `packages/generacy-plugin-claude-code/package.json`
- [ ] T012 [P] [US1] Add `prepublishOnly` script to `packages/generacy-plugin-cloud-build/package.json`
- [ ] T013 [P] [US1] Add `prepublishOnly` script to `packages/generacy-plugin-copilot/package.json`
- [ ] T014 [P] [US1] Add `prepublishOnly` script to `packages/github-actions/package.json`
- [ ] T015 [P] [US1] Add `prepublishOnly` script to `packages/github-issues/package.json`
- [ ] T016 [P] [US1] Add `prepublishOnly` script to `packages/jira/package.json`
- [ ] T017 [P] [US1] Add `prepublishOnly` script to `packages/knowledge-store/package.json`
- [ ] T018 [P] [US1] Add `prepublishOnly` script to `packages/orchestrator/package.json`
- [ ] T019 [P] [US1] Add `prepublishOnly` script to `packages/workflow-engine/package.json`

## Phase 3: Changeset & Publish

- [ ] T020 [US1] Create changeset file for `@generacy-ai/orchestrator` (patch) — triggers transitive bump of `@generacy-ai/generacy` via `updateInternalDependencies: "patch"`
- [ ] T021 [US1] Verify `prepublishOnly` works locally — run `pnpm publish --dry-run` from `packages/orchestrator/` and confirm the script runs and passes (deps should be rewritten in dry-run tarball)

## Phase 4: Verification

- [ ] T022 [US1] Post-publish: run `npm pack @generacy-ai/orchestrator@<new-version>` and verify zero `workspace:` literals in the tarball `package.json`
- [ ] T023 [US1] Post-publish: run `npx -y @generacy-ai/generacy@stable launch --claim=<test-code>` on a clean npm cache and verify successful install

## Dependencies & Execution Order

- **T001, T002**: Investigation tasks, can run in parallel. Inform whether release.yml needs changes.
- **T003**: Must complete before T004–T019 (they depend on the script existing).
- **T004–T019**: All parallel — each touches a different `package.json` file.
- **T020**: Depends on T003–T019 being complete (guardrails in place before creating release changeset).
- **T021**: Depends on T003 + T018 (needs script + orchestrator's prepublishOnly).
- **T022–T023**: Post-merge/publish verification — run after the release pipeline executes on `main`.

**Parallel opportunities**: T001‖T002, T004–T019 (all 16 packages simultaneously), T022‖T023.
