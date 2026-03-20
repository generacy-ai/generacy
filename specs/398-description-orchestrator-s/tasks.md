# Tasks: Orchestrator Job Lifecycle Events via Relay WebSocket

**Input**: Design documents from `/specs/398-description-orchestrator-s/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/job-events.schema.json
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Types & Interfaces

- [X] T001 [US1] Add `RelayJobEvent` interface and update `RelayMessage` union in `packages/orchestrator/src/types/relay.ts`
  - Add `RelayJobEvent` with `type: 'event'`, `event: string`, `data: Record<string, unknown>`, `timestamp: string`
  - Add `RelayJobEvent` to the `RelayMessage` discriminated union

- [X] T002 [P] [US1] Add `jobId` to `WorkerContext` and export `JobEventEmitter` type in `packages/orchestrator/src/worker/types.ts`
  - Add `jobId: string` to `WorkerContext` interface
  - Export `JobEventEmitter` type: `(event: string, data: Record<string, unknown>) => void`

## Phase 2: Event Emission Infrastructure

- [X] T003 [US1] Add `emitJobEvent()` method to `RelayBridge` in `packages/orchestrator/src/services/relay-bridge.ts`
  - Public method: `emitJobEvent(event: string, data: Record<string, unknown>): void`
  - Sends `{ type: 'event', event, data, timestamp: new Date().toISOString() }` via `this.client.send()`
  - No-op when `!this.client.isConnected`
  - Wrapped in try/catch with error logging (fire-and-forget)

- [X] T004 [P] [US1] Add `jobEventEmitter` to `ClaudeCliWorkerDeps` in `packages/orchestrator/src/worker/claude-cli-worker.ts`
  - Add `jobEventEmitter?: JobEventEmitter` to the deps interface
  - Store as instance field for use in `handle()`

- [X] T005 [P] [US1] Add `jobEventEmitter` to `PhaseLoopDeps` in `packages/orchestrator/src/worker/phase-loop.ts`
  - Add `jobEventEmitter?: JobEventEmitter` to deps interface
  - Store for use in `executeLoop()`

## Phase 3: Core Event Emission

- [X] T006 [US1] Emit `job:created`, `job:completed`, and `job:failed` in `ClaudeCliWorker.handle()` (`packages/orchestrator/src/worker/claude-cli-worker.ts`)
  - Generate `jobId = crypto.randomUUID()` at job dequeue
  - Add `jobId` to `WorkerContext`
  - Emit `job:created` after context creation with payload: `{ jobId, workflowName, owner, repo, issueNumber, status: 'active', currentStep: startPhase }`
  - Emit `job:completed` at each completion point (standard, epic, PR feedback) with `status: 'completed'`
  - Emit `job:failed` at each failure point with `status: 'failed'` and `error` message
  - Pass `jobEventEmitter` to `PhaseLoop` via `PhaseLoopDeps`

- [X] T007 [US1] Emit `job:phase_changed` and `job:paused` in `PhaseLoop.executeLoop()` (`packages/orchestrator/src/worker/phase-loop.ts`)
  - At TOP of phase loop iteration (before `labelManager.onPhaseStart()`), emit `job:phase_changed` with `{ jobId, currentStep: phase, status: 'active', workflowName, owner, repo, issueNumber }`
  - When gate activates (before returning `gateHit: true`), emit `job:paused` with `{ jobId, currentStep: phase, status: 'paused', gateLabel, workflowName, owner, repo, issueNumber }`

## Phase 4: Worker Mode Wiring

- [X] T008 [US1] Wire relay client into worker mode in `packages/orchestrator/src/server.ts`
  - In `isWorkerMode` block, check if `config.relay.apiKey` is set
  - If set, create a `ClusterRelayClient` for event emission
  - Create `JobEventEmitter` callback that sends through this client
  - Pass to `ClaudeCliWorker` via `jobEventEmitter` dep
  - Connect client on server ready; disconnect on shutdown

## Phase 5: Tests

- [X] T009 [US1] Add unit test for `RelayBridge.emitJobEvent()` — test event sending and no-op when disconnected
- [X] T010 [P] [US1] Update `ClaudeCliWorker` tests to verify `job:created`, `job:completed`, `job:failed` emissions
- [X] T011 [P] [US1] Update/add `PhaseLoop` tests to verify `job:phase_changed` and `job:paused` emissions

## Dependencies & Execution Order

**Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5** (sequential phase boundaries)

### Phase 1 (Types):
- T001 and T002 can run in parallel — they modify different files (`relay.ts` vs `worker/types.ts`)

### Phase 2 (Infrastructure):
- T003 depends on T001 (uses `RelayJobEvent` type)
- T004 and T005 depend on T002 (use `JobEventEmitter` type)
- T003, T004, T005 can run in parallel with each other (different files)

### Phase 3 (Core):
- T006 depends on T004 (uses `jobEventEmitter` in `ClaudeCliWorker`)
- T007 depends on T005 and T006 (uses `jobEventEmitter` in `PhaseLoop`, needs context changes from T006)

### Phase 4 (Wiring):
- T008 depends on T003 and T006 (wires relay client to worker, needs both sides ready)

### Phase 5 (Tests):
- T009 depends on T003 (tests `RelayBridge.emitJobEvent()`)
- T010 depends on T006 (tests worker event emissions)
- T011 depends on T007 (tests phase loop event emissions)
- T009, T010, T011 can run in parallel (different test files)
