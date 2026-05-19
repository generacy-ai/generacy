# Tasks: Post-Activation Retry on Cluster Restart

**Input**: Design documents from `/specs/652-repro-1-launch-cluster/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Service

- [X] T001 Create `PostActivationRetryService` in `packages/orchestrator/src/services/post-activation-retry.ts`. Implement `checkPostActivationState()` — reads `/var/lib/generacy/post-activation-complete` (existence check via `existsSync`) and `/var/lib/generacy/cluster-api-key` to produce `PostActivationState { activated, postActivationComplete, needsRetry }`. Paths configurable via constructor options (`PostActivationRetryOptions`).
- [X] T002 In the same file, implement `triggerPostActivationRetry()` — polls `probeControlPlaneSocket()` until ready (reuse existing helper from `packages/orchestrator/src/services/control-plane-probe.ts`), then sends `POST /lifecycle/bootstrap-complete` to the control-plane Unix socket using `node:http` with `socketPath`. Include synthetic actor headers (`x-generacy-actor-user-id: system`, `x-generacy-actor-session-id: post-activation-retry`). Request body: `{ action: 'bootstrap-complete' }`.
- [X] T003 In the same file, add error propagation on retry failure: push `degraded` status via `StatusReporter.pushStatus('degraded', reason)` and emit `cluster.bootstrap` relay event with `{ status: 'failed', reason, error }` payload via the orchestrator's relay client (accept relay send function as constructor dependency). Log structured error for `docker compose logs` visibility.
- [X] T004 In the same file, add relay event emission on retry trigger: emit `cluster.bootstrap` event with `{ status: 'retrying', reason: 'post-activation-incomplete', attempt: 'restart' }` before the HTTP call.

## Phase 2: Integration

- [X] T005 Modify `packages/orchestrator/src/server.ts` — in the sync activation branch (line ~350, `else if (!isWorkerMode && config.relay.apiKey)`), after `initializeRelayBridge()`, call `checkPostActivationState()`. If `needsRetry` is true, call `triggerPostActivationRetry()` as fire-and-forget (async, `.catch(log)`). Pass the relay client ref for event emission.
- [X] T006 Modify `packages/orchestrator/src/server.ts` — in `activateInBackground()` (line ~661, after `'Cluster activation complete'` log), add the same post-activation state check and retry trigger. This handles wizard-mode activation where the API key is obtained during this startup but post-activation may have failed on a prior container lifecycle.
- [X] T007 Export `PostActivationRetryService` from the orchestrator services barrel (or import directly in `server.ts` if no barrel exists). Ensure the service accepts a logger (`FastifyBaseLogger`) via constructor options.

## Phase 3: Tests

- [X] T008 [P] Create test file `packages/orchestrator/src/__tests__/post-activation-retry.test.ts`. Test `checkPostActivationState()`: (1) no API key, no flag → `needsRetry: false`; (2) API key exists, flag exists → `needsRetry: false`; (3) API key exists, no flag → `needsRetry: true`. Use temp directories with real files.
- [X] T009 [P] In the same test file, test `triggerPostActivationRetry()`: mock `probeControlPlaneSocket` and create a local HTTP server on a Unix socket to assert the lifecycle POST is sent with correct path, headers, and body. Verify relay event emission (`retrying` event before call).
- [X] T010 [P] In the same test file, test retry failure path: mock the HTTP call to return 500 or socket error. Verify `StatusReporter.pushStatus('degraded', ...)` is called and relay failure event is emitted.
- [X] T011 In the same test file, test multi-restart no-op: API key exists + completion flag exists → verify `triggerPostActivationRetry()` is never called.

## Phase 4: Validation

- [X] T012 Run `pnpm -F @generacy-ai/orchestrator test` — verify all existing and new tests pass.
- [X] T013 Run `pnpm -F @generacy-ai/orchestrator build` — verify TypeScript compilation succeeds with no errors.

## Dependencies & Execution Order

- **T001 → T002 → T003/T004**: Sequential within the service file (each builds on prior)
- **T005/T006 depend on T001-T004**: Integration requires the service to exist
- **T007 depends on T001**: Export requires the service
- **T008, T009, T010 are [P]**: Independent test scenarios, can be written in parallel
- **T011 depends on T008**: Builds on same test setup
- **T012/T013 depend on all prior tasks**: Final validation

**Phase boundaries**: Phase 1 → Phase 2 → Phase 3 → Phase 4 (sequential)
**Parallel opportunities**: T003/T004 (same file, independent logic), T008/T009/T010 (independent test cases)
