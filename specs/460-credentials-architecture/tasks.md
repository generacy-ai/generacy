# Tasks: Credhelper Plugin Loader with SHA256 Pin Verification

**Input**: Design documents from `/specs/460-credentials-architecture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Types & Fixtures Setup

- [ ] T001 Define loader types in `packages/credhelper/src/types/loader.ts` — `LoaderConfig`, `DiscoveredPlugin`, `PluginManifest` interfaces as specified in data-model.md
- [ ] T002 [P] Create mock plugin fixture `packages/credhelper/src/__tests__/fixtures/plugins/generacy-credhelper-plugin-mock/` — valid plugin with `package.json` (containing `credhelperPlugin` field) and `index.js` implementing `CredentialTypePlugin`
- [ ] T003 [P] Create bad-schema plugin fixture `packages/credhelper/src/__tests__/fixtures/plugins/generacy-credhelper-plugin-bad-schema/` — plugin with invalid `credentialSchema` (missing `.parse` method)
- [ ] T004 [P] Create duplicate-type plugin fixture `packages/credhelper/src/__tests__/fixtures/plugins/generacy-credhelper-plugin-duplicate/` — valid plugin but with same `type` as mock plugin

## Phase 2: Core Implementation

- [ ] T005 Implement standalone plugin discovery in `packages/credhelper/src/loader/discover.ts` — `discoverPlugins(corePaths, communityPaths): Promise<DiscoveredPlugin[]>` scanning directories matching `@generacy/credhelper-plugin-*` and `generacy-credhelper-plugin-*` patterns, reading `credhelperPlugin` manifest from `package.json`, tagging `isCore` based on source path
- [ ] T006 [P] Implement SHA256 pin verification in `packages/credhelper/src/loader/verify.ts` — `verifyPluginPins(plugins, trustedPins): DiscoveredPlugin[]` using `crypto.createHash('sha256')` on entry point file, skipping core plugins, throwing descriptive errors for unpinned/mismatched community plugins
- [ ] T007 [P] Implement plugin validation in `packages/credhelper/src/loader/validate.ts` — `validatePlugin(mod: unknown): CredentialTypePlugin` runtime duck-type checking for `type` (string), `credentialSchema` (has `.parse`), `supportedExposures` (non-empty ExposureKind array), `renderExposure` (function), optional `scopeSchema`
- [ ] T008 Implement main loader function in `packages/credhelper/src/loader/load-credential-plugins.ts` — `loadCredentialPlugins(config: LoaderConfig): Promise<Map<string, CredentialTypePlugin>>` orchestrating discover → verify → `await import()` → validate → register, detecting duplicate types
- [ ] T009 Create barrel export in `packages/credhelper/src/loader/index.ts` — re-export `loadCredentialPlugins`, `LoaderConfig`, `DiscoveredPlugin`

## Phase 3: Tests

- [ ] T010 Write unit tests for discovery in `packages/credhelper/src/__tests__/loader/discover.test.ts` — discovery from fixture paths, naming pattern filtering, `isCore` flag, missing `credhelperPlugin` field handling
- [ ] T011 [P] Write unit tests for SHA256 verification in `packages/credhelper/src/__tests__/loader/verify.test.ts` — happy path pin match, missing pin → throw, wrong pin → throw, core plugin bypass
- [ ] T012 [P] Write unit tests for validation in `packages/credhelper/src/__tests__/loader/validate.test.ts` — valid plugin passes, missing `type` → throw, invalid `credentialSchema` → throw, missing `renderExposure` → throw, invalid `supportedExposures` → throw
- [ ] T013 Write integration test in `packages/credhelper/src/__tests__/loader/load-credential-plugins.test.ts` — full flow with mock plugins on disk: happy path with core+community, all error modes (missing pin, wrong pin, duplicate type, invalid schema)

## Phase 4: Exports & Build Verification

- [ ] T014 Update `packages/credhelper/src/index.ts` — add exports for `loadCredentialPlugins`, `LoaderConfig`, `DiscoveredPlugin` from `./loader/index.js`
- [ ] T015 Verify build and tests pass — run `pnpm build` and `pnpm test` in the credhelper package

## Dependencies & Execution Order

**Phase 1** (Setup):
- T001 must complete before Phase 2 (loader types are imported by all loader modules)
- T002, T003, T004 can run in parallel with each other and with T001 (fixture files, no code dependencies)

**Phase 2** (Core Implementation):
- T005 (discover) and T006 (verify) and T007 (validate) can run in parallel — they are independent modules
- T008 (main loader) depends on T005, T006, T007 — it imports and orchestrates all three
- T009 (barrel) depends on T008

**Phase 3** (Tests):
- T010 depends on T005 (tests the discover module)
- T011 depends on T006 (tests the verify module) — parallel with T010, T012
- T012 depends on T007 (tests the validate module) — parallel with T010, T011
- T013 depends on T008 and all fixtures (T002-T004) — integration test of full flow

**Phase 4** (Exports & Verification):
- T014 depends on T009 (needs loader barrel to exist)
- T015 depends on all prior tasks

**Parallel opportunities**: Up to 3 tasks can run concurrently in Phase 1 (T002-T004), Phase 2 (T005-T007), and Phase 3 (T010-T012).
