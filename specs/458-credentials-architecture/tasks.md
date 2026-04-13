# Tasks: @generacy-ai/credhelper Package (Phase 1 — Contracts)

**Input**: Design documents from `/specs/458-credentials-architecture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Package Scaffold

- [ ] T001 Create `packages/credhelper/package.json` following `@generacy-ai/config` pattern — name `@generacy-ai/credhelper`, deps: `zod ^3.23.0`, devDeps: `yaml ^2.4.0`, `vitest`
- [ ] T002 Create `packages/credhelper/tsconfig.json` extending monorepo root config (ES2022, NodeNext, strict)
- [ ] T003 Create empty barrel `packages/credhelper/src/index.ts`
- [ ] T004 Verify `pnpm install` resolves the new workspace package and `tsc` compiles

## Phase 2: Core Type Definitions

- [ ] T005 [P] Create `packages/credhelper/src/types/secret.ts` — `Secret` interface with `value: string` and `format?: 'token' | 'json' | 'key' | 'opaque'`
- [ ] T006 [P] Create `packages/credhelper/src/types/exposure.ts` — `ExposureKind` type union, `ExposureConfig` discriminated union (5 variants by `kind`), `ExposureOutput` discriminated union (5 variants by `kind`)
- [ ] T007 [P] Create `packages/credhelper/src/types/context.ts` — `BackendClient` interface with `fetchSecret(key): Promise<string>`, `MintContext` with `credentialId`, `backendKey`, `backend`, `scope`, `ttl`, `ResolveContext` with `credentialId`, `backendKey`, `backend`
- [ ] T008 [P] Create `packages/credhelper/src/types/plugin.ts` — `CredentialTypePlugin` interface with `type`, `credentialSchema`, `scopeSchema?`, `supportedExposures`, `mint?`, `resolve?`, `renderExposure`
- [ ] T009 [P] Create `packages/credhelper/src/types/session.ts` — `BeginSessionRequest`, `BeginSessionResponse`, `EndSessionRequest`
- [ ] T010 [P] Create `packages/credhelper/src/types/launch.ts` — `LaunchRequestCredentials` with `role`, `uid`, `gid`

## Phase 3: Zod Schemas

- [ ] T011 [P] Create `packages/credhelper/src/schemas/backends.ts` — `BackendAuthSchema` (passthrough with `mode`), `BackendEntrySchema`, `BackendsConfigSchema`, inferred types
- [ ] T012 [P] Create `packages/credhelper/src/schemas/credentials.ts` — `MintConfigSchema`, `CredentialEntrySchema`, `CredentialsConfigSchema`, inferred types
- [ ] T013 [P] Create `packages/credhelper/src/schemas/roles.ts` — `RoleExposeSchema`, `RoleCredentialRefSchema`, `ProxyRuleSchema`, `ProxyConfigSchema`, `DockerRuleSchema`, `DockerConfigSchema`, `RoleConfigSchema`, inferred types
- [ ] T014 [P] Create `packages/credhelper/src/schemas/trusted-plugins.ts` — `PluginPinSchema`, `TrustedPluginsSchema`, inferred types
- [ ] T015 [P] Create `packages/credhelper/src/schemas/exposure.ts` — Zod schemas for `ExposureConfig` and `ExposureOutput` discriminated unions using `z.discriminatedUnion('kind', [...])`

## Phase 4: Barrel Exports

- [ ] T016 Wire all types and schemas through `packages/credhelper/src/index.ts` — re-export all interfaces, types, enums from `src/types/*.ts` and all schemas + inferred types from `src/schemas/*.ts`

## Phase 5: Test Fixtures & Schema Tests

- [ ] T017 Create YAML fixture files in `packages/credhelper/src/__tests__/fixtures/` — `backends.yaml`, `credentials.yaml`, `credentials-local.yaml`, `roles/reviewer.yaml`, `roles/developer.yaml`, `roles/devops.yaml`, `trusted-plugins.yaml` matching architecture plan examples
- [ ] T018 [P] Create `packages/credhelper/src/__tests__/backends-schema.test.ts` — parse backends fixture, validate against `BackendsConfigSchema`, test invalid entries rejected
- [ ] T019 [P] Create `packages/credhelper/src/__tests__/credentials-schema.test.ts` — parse credentials fixture, validate against `CredentialsConfigSchema`, test overlay parsing, test missing required fields rejected
- [ ] T020 [P] Create `packages/credhelper/src/__tests__/roles-schema.test.ts` — parse each role fixture, validate against `RoleConfigSchema`, test `extends`, test exposure validation, test proxy/docker blocks
- [ ] T021 [P] Create `packages/credhelper/src/__tests__/trusted-plugins-schema.test.ts` — parse fixture, validate against `TrustedPluginsSchema`, test invalid entries

## Phase 6: Build Verification

- [ ] T022 Run `pnpm run build` in `packages/credhelper/` — must compile cleanly with no errors
- [ ] T023 Run `pnpm run test` in `packages/credhelper/` — all schema tests pass
- [ ] T024 Verify all types and schemas are accessible from barrel export; run full monorepo build to check for regressions

## Dependencies & Execution Order

```
Phase 1 (T001–T004) → sequential, scaffold must complete first
Phase 2 (T005–T010) → all [P] parallel, no interdependencies
Phase 3 (T011–T015) → all [P] parallel, depends on Phase 2 types (ExposureKind used in schemas)
Phase 4 (T016)      → depends on Phases 2+3 completion
Phase 5 (T017)      → fixtures first, then T018–T021 [P] parallel
Phase 6 (T022–T024) → sequential, final verification
```

**Parallel opportunities**: 6 type tasks in Phase 2, 5 schema tasks in Phase 3, 4 test tasks in Phase 5 — significant parallelization possible within each phase.
