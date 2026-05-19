# Tasks: Activation Poll Response cloud_url Fix

**Input**: Design documents from `/specs/517-context-cluster-activation/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Schema & Type Fix (activation-client)

- [X] T001 [P] [US1] Add `cloud_url: z.string().url()` to `PollResponseSchema` approved variant in `packages/activation-client/src/types.ts`
- [X] T002 [P] [US1] Add optional `cloudUrl?: string` to `ActivationResult` interface in `packages/activation-client/src/types.ts`
- [X] T003 [P] [US1] Add unit test: `PollResponseSchema` accepts approved response with `cloud_url` in `packages/activation-client/test/types.test.ts`

## Phase 2: Persistence & Propagation (orchestrator activation)

- [X] T004 [US1] Update `activate()` device-flow path to persist `pollResult.cloud_url` (not input config) to `cluster.json` and return `cloudUrl` in result — `packages/orchestrator/src/activation/index.ts`
- [X] T005 [US1] Update `activate()` existing-key path to return `cloudUrl` from `metadata.cloud_url` — `packages/orchestrator/src/activation/index.ts`
- [X] T006 [P] [US1] Add unit test: `activate()` returns `cloudUrl` from device-flow path — `packages/orchestrator/test/activation/index.test.ts`
- [X] T007 [P] [US1] Add unit test: `activate()` returns `cloudUrl` from existing-key path — `packages/orchestrator/test/activation/index.test.ts`

## Phase 3: Boot-Time Override (orchestrator server.ts)

- [X] T008 [US1] Update `server.ts` boot sequence to read `cloudUrl` from activation result and override `config.activation.cloudUrl` (HTTPS) and `config.relay.cloudUrl` (derived WSS) — `packages/orchestrator/src/server.ts:307-315`
- [X] T009 [US1] Add integration test: boot sequence correctly overrides relay URL from activation result — `packages/orchestrator/test/server.test.ts`

## Phase 4: Verification

- [X] T010 Build `activation-client` and `orchestrator` packages, verify no type errors
- [X] T011 Run full test suite for both packages

## Dependencies & Execution Order

- **T001 and T002** are parallel edits to the same file but different sections; can be done together in a single edit.
- **T003** can run in parallel with T001/T002 (test file is separate).
- **T004 and T005** depend on T001/T002 (need updated types from activation-client). They modify the same file and should be done sequentially.
- **T006 and T007** can run in parallel with each other after T004/T005.
- **T008** depends on T004/T005 (needs `cloudUrl` in `ActivationResult`).
- **T009** depends on T008.
- **T010** depends on all code changes (T001-T002, T004-T005, T008).
- **T011** depends on T010 (build must pass first).

```
T001 ──┐
T002 ──┼──► T004 → T005 ──► T008 → T009 ──► T010 → T011
T003 ──┘         ↘                          ↗
                  T006, T007 (parallel) ───┘
```
