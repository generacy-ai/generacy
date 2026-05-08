# Tasks: Disambiguate `GENERACY_CLOUD_URL`

**Input**: Design documents from `/specs/549-problem-single-env-var/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema & Tests

- [ ] T001 [US1] Add `CloudUrlsSchema` and optional `cloud` field to `LaunchConfigSchema` in `packages/generacy/src/cli/commands/launch/types.ts`
  - Add `CloudUrlsSchema = z.object({ apiUrl: z.string().url(), appUrl: z.string().url(), relayUrl: z.string().url() })`
  - Add `cloud: CloudUrlsSchema.optional()` to `LaunchConfigSchema`
  - Keep `cloudUrl: z.string().url()` as deprecated alias
  - Export `CloudUrls` type

- [ ] T002 [P] [US1] Write schema tests for `LaunchConfigSchema` with and without `cloud` object in `packages/generacy/src/cli/commands/launch/__tests__/cloud-client.test.ts`
  - Test: parses successfully with `cloud` object present
  - Test: parses successfully without `cloud` object (backward compat)
  - Test: rejects invalid URLs in `cloud` object
  - Test: `cloud` fields are independently validated

## Phase 2: Reader-Side Changes

- [ ] T010 [US1] [US2] Rename `resolveCloudUrl()` to `resolveApiUrl()` and add `GENERACY_API_URL` precedence in `packages/generacy/src/cli/utils/cloud-url.ts`
  - Read `GENERACY_API_URL` first, then `GENERACY_CLOUD_URL` with debug deprecation log, then default
  - Use module-scoped `let deprecationLogged = false` flag for once-per-process log
  - Rename function from `resolveCloudUrl` to `resolveApiUrl`

- [ ] T011 [P] [US1] Update `resolveApiUrl()` tests in `packages/generacy/src/cli/utils/__tests__/cloud-url.test.ts`
  - Test: `GENERACY_API_URL` takes precedence over `GENERACY_CLOUD_URL`
  - Test: falls back to `GENERACY_CLOUD_URL` with deprecation log when `GENERACY_API_URL` absent
  - Test: default `https://api.generacy.ai` when neither env var set
  - Test: CLI flag takes precedence over both env vars

- [ ] T012 [US1] Update callers of `resolveCloudUrl` → `resolveApiUrl` in launch and deploy commands
  - `packages/generacy/src/cli/commands/launch/index.ts:99` — `resolveCloudUrl(opts.cloudUrl)` → `resolveApiUrl(opts.cloudUrl)`
  - `packages/generacy/src/cli/commands/deploy/index.ts:36` — `resolveCloudUrl(options.cloudUrl)` → `resolveApiUrl(options.cloudUrl)`
  - Update import statements in both files

- [ ] T020 [P] [US1] [US2] Split orchestrator config loader reads for activation and relay in `packages/orchestrator/src/config/loader.ts`
  - Line ~246: Read `GENERACY_API_URL`, fall back to `GENERACY_CLOUD_URL` with deprecation log for activation config
  - Line ~263: Read `GENERACY_RELAY_URL`, fall back to `GENERACY_CLOUD_URL` with deprecation log for relay config
  - Lines ~280-295: Remove `projectId` append logic (dead code — cloud pre-appends `?projectId=`)

- [ ] T021 [P] [US1] Update orchestrator loader tests in `packages/orchestrator/src/config/__tests__/loader-workspace.test.ts`
  - Test: `GENERACY_API_URL` populates `activation.cloudUrl`
  - Test: `GENERACY_RELAY_URL` populates `relay.cloudUrl`
  - Test: fallback to `GENERACY_CLOUD_URL` for both when new vars absent
  - Test: `projectId` no longer appended to relay URL

- [ ] T030 [P] [US1] Update `ClusterRelayClientOptions` JSDoc comment in `packages/cluster-relay/src/relay.ts:26`
  - Change comment from `GENERACY_CLOUD_URL` to `GENERACY_RELAY_URL`
  - Note: No code change needed — env var read happens in orchestrator config loader, not here

## Phase 3: Writer-Side Changes

- [ ] T040 [US1] [US2] Update `scaffoldEnvFile()` to write `GENERACY_API_URL` and `GENERACY_RELAY_URL` in `packages/generacy/src/cli/commands/cluster/scaffolder.ts`
  - Add optional `cloud?: { apiUrl: string; relayUrl: string }` to `ScaffoldEnvInput`
  - When `cloud` present: write `GENERACY_API_URL=${cloud.apiUrl}` and `GENERACY_RELAY_URL=${cloud.relayUrl}`
  - When `cloud` absent: write `GENERACY_API_URL=${cloudUrl}` and `GENERACY_RELAY_URL=${deriveRelayUrl(cloudUrl, projectId)}`
  - Replace `GENERACY_CLOUD_URL=${relayUrl}` line with new env var lines

- [ ] T041 [P] [US1] Update scaffolder tests in `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts`
  - Test: `.env` contains `GENERACY_API_URL` and `GENERACY_RELAY_URL` (not `GENERACY_CLOUD_URL`)
  - Test: with `cloud` object, values come directly from cloud
  - Test: without `cloud` object, `GENERACY_API_URL` from `cloudUrl`, `GENERACY_RELAY_URL` derived

- [ ] T050 [US1] Update launch registry write to use `cloud.appUrl` in `packages/generacy/src/cli/commands/launch/index.ts:194`
  - Change `cloudUrl: config.cloudUrl` to `cloudUrl: config.cloud?.appUrl ?? config.cloudUrl`

- [ ] T051 [P] [US1] Update deploy registry write to use `cloud.appUrl` in `packages/generacy/src/cli/commands/deploy/index.ts:86`
  - Change `cloudUrl` value to `launchConfig.cloud?.appUrl ?? launchConfig.cloudUrl`

- [ ] T060 [US1] Update `STUB_LAUNCH_CONFIG` in `packages/generacy/src/cli/commands/launch/cloud-client.ts`
  - Add `cloud: { apiUrl: 'http://localhost:3000', appUrl: 'http://localhost:3000', relayUrl: 'ws://localhost:3000/relay?projectId=proj_stub001' }` to the stub

## Phase 4: Launch Scaffolder Integration

- [ ] T070 [US1] Update launch `scaffoldProject()` to pass `cloud` from `LaunchConfig` to shared scaffolder in `packages/generacy/src/cli/commands/launch/scaffolder.ts`
  - Pass `cloud.apiUrl` and `cloud.relayUrl` through to `scaffoldEnvFile()` when `config.cloud` present

- [ ] T071 [P] [US1] Update launch scaffolder tests in `packages/generacy/src/cli/commands/launch/__tests__/scaffolder.test.ts`
  - Test: `cloud` object flows through to `.env` generation
  - Test: backward compat when `cloud` absent

## Phase 5: Verification

- [ ] T080 Run existing test suites to verify no regressions
  - `pnpm -F @generacy-ai/generacy test`
  - `pnpm -F @generacy-ai/orchestrator test`
  - `pnpm -F @generacy-ai/cluster-relay test`

- [ ] T081 [P] Grep codebase for remaining direct `GENERACY_CLOUD_URL` reads without fallback chain
  - Verify no reader uses `process.env['GENERACY_CLOUD_URL']` without also checking `GENERACY_API_URL` or `GENERACY_RELAY_URL`
  - Verify scaffolded `.env` no longer contains `GENERACY_CLOUD_URL`

## Dependencies & Execution Order

```
T001 (Schema) ──────────────┐
                             ├──▶ T040 (Scaffolder writer) ──▶ T070 (Launch scaffolder integration)
T010 (CLI reader) ──▶ T012 ─┤
                             ├──▶ T050 (Launch registry)
T020 (Orchestrator) ────────┤
                             └──▶ T051 (Deploy registry)
T030 (Cluster-relay docs) ── independent

T002, T011, T021, T041, T071 ── test tasks, parallel with their respective implementation
T060 (Stub fixture) ── after T001
T080, T081 ── final verification, after all implementation
```

**Parallel opportunities**:
- T002, T011, T020, T021, T030 can all run in parallel (different packages/files)
- T041, T050, T051 can run in parallel
- T080 and T081 can run in parallel

**Sequential constraints**:
- T001 must complete before T040, T050, T051, T060
- T010 must complete before T012
- T040 must complete before T070
- All implementation before T080/T081
