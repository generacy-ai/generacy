# Tasks: Cluster-Side Device-Flow Activation Client

**Input**: Design documents from `/specs/492-context-first-cluster-boot/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Foundation

- [ ] T001 Create Zod schemas and TypeScript types (`packages/orchestrator/src/activation/types.ts`): DeviceCodeResponseSchema, PollRequestSchema, PollResponseSchema (discriminated union), ActivationResultSchema, ClusterJsonSchema, ActivationOptions interface, HttpClient/HttpResponse interfaces
- [ ] T002 [P] Create ActivationError class with error codes (`packages/orchestrator/src/activation/errors.ts`): CLOUD_UNREACHABLE, DEVICE_CODE_EXPIRED, KEY_WRITE_FAILED, INVALID_RESPONSE

## Phase 2: Core Implementation

- [ ] T003 [P] Implement HTTP client for device-code endpoints (`packages/orchestrator/src/activation/client.ts`): `requestDeviceCode()` with retry (5x, exponential 2s-32s, ±10% jitter), `pollDeviceCode()` single-shot POST, use native `node:http`/`node:https`, Zod-validate responses, never log API key
- [ ] T004 [P] Implement atomic file persistence (`packages/orchestrator/src/activation/persistence.ts`): `readKeyFile()` returns key or null (treats corrupt as absent), `writeKeyFile()` atomic via `.tmp` + `rename()` with mode 0600, `readClusterJson()` reads + validates companion metadata, `writeClusterJson()` writes cluster_id/project_id/org_id/cloud_url/activated_at with mode 0644
- [ ] T005 Implement poll loop with slow_down/expired handling (`packages/orchestrator/src/activation/poller.ts`): accept device_code + interval + expires_in, honor `slow_down` (+5s, max 60s), detect `expired` status, return approved PollResponse, respect expires_in timeout bound

## Phase 3: Assembly & Config

- [ ] T006 Implement `activate()` orchestrator function (`packages/orchestrator/src/activation/index.ts`): check key file -> if present read + return ActivationResult, if absent run device-code flow (up to maxCycles=3 on expiry), print activation instructions to stdout, persist key + cluster.json on approval, re-export types
- [ ] T007 [P] Add `cloudUrl` and `clusterApiKeyId` to config schema (`packages/orchestrator/src/config/schema.ts`): `cloudUrl: z.string().url().optional()`, `clusterApiKeyId: z.string().optional()` on RelayConfig
- [ ] T008 [P] Add GENERACY_CLOUD_URL env var to config loader (`packages/orchestrator/src/config/loader.ts`): read `GENERACY_CLOUD_URL`, derive fallback from relay WSS URL (`wss:` -> `https:`, strip pathname), hard-coded default `https://api.generacy.ai`, expose `cloudUrl` on config

## Phase 4: Integration

- [ ] T009 Wire activation into orchestrator startup (`packages/orchestrator/src/server.ts`): call `activate()` before relay client construction, set `config.relay.apiKey` and `config.relay.clusterApiKeyId` from result, skip activation when key file already present

## Phase 5: Tests

- [ ] T010 [P] Unit tests for HTTP client (`packages/orchestrator/src/activation/__tests__/client.test.ts`): happy path device-code request, retry on network failure (verify 5 retries + backoff), Zod validation failure, poll request happy path
- [ ] T011 [P] Unit tests for poll loop (`packages/orchestrator/src/activation/__tests__/poller.test.ts`): happy path (pending -> approved), slow_down increases interval by 5s, expired returns expired status, expires_in timeout respected, interval capped at 60s
- [ ] T012 [P] Unit tests for file persistence (`packages/orchestrator/src/activation/__tests__/persistence.test.ts`): write + read key file round-trip, atomic write (verify .tmp then rename), mode 0600 on key file, read returns null for missing file, corrupt key file treated as absent, cluster.json write + read round-trip
- [ ] T013 Integration test with fake cloud server (`packages/orchestrator/src/activation/__tests__/activate.test.ts`): spin up local HTTP server mimicking cloud endpoints, full happy path (device-code -> poll -> approved -> persisted), slow_down path, expired + auto-retry path, existing key file skips activation, API key never appears in log output

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5

**Parallel opportunities within phases**:
- Phase 1: T001 and T002 can run in parallel (independent type/error files)
- Phase 2: T003 and T004 can run in parallel (independent modules); T005 depends on T003 (uses client types)
- Phase 3: T006 depends on T003-T005; T007 and T008 can run in parallel with each other and with T006
- Phase 5: T010, T011, T012 can all run in parallel; T013 depends on all prior tasks

**Critical path**: T001 → T003 → T005 → T006 → T009 → T013
