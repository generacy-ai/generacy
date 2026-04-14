# Tasks: Core Credential Type Plugins (7 plugins)

**Input**: Design documents from `/specs/463-credentials-architecture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

---

## Phase 1: Type Extensions (foundation)

All type changes must land before plugin implementation begins.

- [X] T001 [US1,US2,US3,US4] Add `config` field to `MintContext` and `ResolveContext` in `packages/credhelper/src/types/context.ts`
- [X] T002 [P] [US1,US2,US3,US4] Create `PluginExposureData` discriminated union type in `packages/credhelper/src/types/plugin-exposure.ts` — variants: `PluginEnvExposure`, `PluginGitCredentialHelperExposure`, `PluginGcloudExternalAccountExposure`, `PluginLocalhostProxyExposure`
- [X] T003 [US1,US2,US3,US4] Update `CredentialTypePlugin.renderExposure()` return type from `ExposureOutput` to `PluginExposureData` in `packages/credhelper/src/types/plugin.ts`
- [X] T004 [P] [US1,US2,US3,US4] Export `PluginExposureData` and related types from `packages/credhelper/src/index.ts`
- [X] T005 [US1,US2,US3,US4] Update plugin validator in `packages/credhelper/src/loader/validate.ts` to work with new `PluginExposureData` return type
- [X] T006 Run `pnpm -F @generacy-ai/credhelper tsc --noEmit` to verify type changes compile

## Phase 2: Core Plugins (main implementation, parallelizable)

Each plugin is independent. All plugins follow the pattern in `research.md` Pattern 1.

- [X] T010 [P] [US1] Implement `github-app` plugin in `packages/credhelper-daemon/src/plugins/core/github-app.ts` — mint-based, `credentialSchema` validates `appId`/`installationId`, `scopeSchema` validates `repositories`/`permissions`, mint calls GitHub Apps API with JWT auth, exposures: env + git-credential-helper
- [X] T011 [P] [US1] Write tests for `github-app` plugin in `packages/credhelper-daemon/__tests__/plugins/github-app.test.ts` — schema validation (valid+invalid), mint with mocked fetch, exposure rendering for both env and git-credential-helper
- [X] T012 [P] [US2] Implement `github-pat` plugin in `packages/credhelper-daemon/src/plugins/core/github-pat.ts` — resolve-based, minimal `credentialSchema`, no `scopeSchema`, exposures: env + git-credential-helper
- [X] T013 [P] [US2] Write tests for `github-pat` plugin in `packages/credhelper-daemon/__tests__/plugins/github-pat.test.ts` — schema validation, resolve with mock backend, exposure rendering
- [X] T014 [P] [US3] Implement `gcp-service-account` plugin in `packages/credhelper-daemon/src/plugins/core/gcp-service-account.ts` — mint-based, `credentialSchema` validates `serviceAccountEmail`/`projectId`, `scopeSchema` validates `scopes[]`, mint calls GCP IAM `generateAccessToken`, exposures: env + gcloud-external-account
- [X] T015 [P] [US3] Write tests for `gcp-service-account` plugin in `packages/credhelper-daemon/__tests__/plugins/gcp-service-account.test.ts` — schema validation, mint with mocked GCP API, exposure rendering
- [X] T016 [P] [US3] Implement `aws-sts` plugin in `packages/credhelper-daemon/src/plugins/core/aws-sts.ts` — mint-based, `credentialSchema` validates `roleArn`/`externalId`/`region`, `scopeSchema` validates `sessionPolicy`/`durationSeconds`, mint calls STS AssumeRole, exposure: env (AWS triple)
- [X] T017 [P] [US3] Write tests for `aws-sts` plugin in `packages/credhelper-daemon/__tests__/plugins/aws-sts.test.ts` — schema validation (including roleArn regex), mint with mocked STS, exposure rendering
- [X] T018 [P] [US4] Implement `stripe-restricted-key` plugin in `packages/credhelper-daemon/src/plugins/core/stripe-restricted-key.ts` — resolve-based, minimal `credentialSchema`, no `scopeSchema`, exposure: env
- [X] T019 [P] [US4] Write tests for `stripe-restricted-key` plugin in `packages/credhelper-daemon/__tests__/plugins/stripe-restricted-key.test.ts` — schema validation, resolve with mock backend, exposure rendering
- [X] T020 [P] [US4] Implement `api-key` plugin in `packages/credhelper-daemon/src/plugins/core/api-key.ts` — resolve-based, `credentialSchema` with optional `upstream` URL, no `scopeSchema`, exposures: env + localhost-proxy
- [X] T021 [P] [US4] Write tests for `api-key` plugin in `packages/credhelper-daemon/__tests__/plugins/api-key.test.ts` — schema validation, resolve with mock backend, exposure rendering for both env and localhost-proxy
- [X] T022 [P] [US2] Implement `env-passthrough` plugin in `packages/credhelper-daemon/src/plugins/core/env-passthrough.ts` — resolve-based, minimal `credentialSchema`, no `scopeSchema`, `backendKey` IS the env var name, exposure: env
- [X] T023 [P] [US2] Write tests for `env-passthrough` plugin in `packages/credhelper-daemon/__tests__/plugins/env-passthrough.test.ts` — schema validation, resolve with mock env backend, exposure rendering

## Phase 3: Integration

Depends on all Phase 1 and Phase 2 tasks being complete.

- [X] T030 [US1,US2,US3,US4] Create core plugin index in `packages/credhelper-daemon/src/plugins/core/index.ts` — static `CORE_PLUGINS` array importing all 7 plugins, exported for daemon registration
- [X] T031 Write registration test in `packages/credhelper-daemon/__tests__/plugins/core-index.test.ts` — verify all 7 plugins in `CORE_PLUGINS`, each has unique `type`, valid interface shape
- [X] T032 [US1,US2,US3,US4] Update `session-manager.ts` to pass `config` field when building `MintContext`/`ResolveContext` — strip common fields (`id`, `type`, `backend`, `backendKey`, `mint`) from credential entry, pass remainder as `config`
- [X] T033 [US1,US2,US3,US4] Update `exposure-renderer.ts` to accept `PluginExposureData` from plugins — for env: use plugin entries, for git-credential-helper: take `{host, protocol, username, password}` and generate shell script with data.sock, for gcloud-external-account: take plugin fields and generate JSON with data.sock URL, for localhost-proxy: take `{upstream, headers}` and configure proxy
- [X] T034 [US1,US2,US3,US4] Update daemon plugin registration to register `CORE_PLUGINS` — ensure core plugins are registered directly alongside community plugins from #460 loader
- [X] T035 Write integration tests in `packages/credhelper-daemon/__tests__/integration/core-plugins.test.ts` — all 7 core plugins register, end-to-end session creation with mock plugin, exposure rendering pipeline: plugin → daemon renderer → session dir files

## Phase 4: Validation & Cleanup

- [X] T040 Run full test suite: `pnpm -F @generacy-ai/credhelper test` and `pnpm -F @generacy-ai/credhelper-daemon test`
- [X] T041 [P] Run type checking: `pnpm -F @generacy-ai/credhelper tsc --noEmit` and `pnpm -F @generacy-ai/credhelper-daemon tsc --noEmit`
- [X] T042 Verify all success criteria: SC-001 (7/7 plugins load), SC-002 (schema validation coverage), SC-003 (mint/resolve tests), SC-004 (exposure rendering tests), SC-005 (all 7 discovered via core registration)

## Dependencies & Execution Order

```
Phase 1: T001 + T002 (parallel) → T003 (needs T002 for PluginExposureData) → T004 + T005 (parallel) → T006
Phase 2: T010–T023 (all parallel, all depend on Phase 1 complete)
Phase 3: T030 → T031, T032 + T033 (parallel) → T034 → T035
Phase 4: T040 + T041 (parallel) → T042
```

**Key parallel opportunities:**
- Phase 1: T001 and T002 are independent type additions
- Phase 2: All 14 tasks (7 plugins × 2 tasks each) can run in parallel — each plugin is in its own file with no cross-dependencies
- Phase 3: T032 (session-manager) and T033 (exposure-renderer) can run in parallel
- Phase 4: Test suite and type checking can run in parallel

**Phase boundaries are sequential:** Phase 1 → Phase 2 → Phase 3 → Phase 4
