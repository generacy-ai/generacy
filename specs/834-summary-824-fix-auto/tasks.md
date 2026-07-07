# Tasks: Wire boot-resume into the wizard startup path (#834)

**Input**: Design documents from `/specs/834-summary-824-fix-auto/`
**Prerequisites**: plan.md (required), spec.md (required), clarifications.md, research.md, data-model.md, contracts/helper-contract.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 is the sole user story (wizard-cluster stop/start auto-resumes tunnel + code-server)

## Phase 1: Helper module (new source file)

- [X] T001 [US1] Create `packages/orchestrator/src/services/post-activation-dispatch.ts` implementing the full contract from `specs/834-summary-824-fix-auto/contracts/helper-contract.md`:
  - Export `DispatchOutcome = 'retry' | 'resume' | 'noop'`.
  - Export `DispatchOptions` interface: `logger: FastifyBaseLogger`, optional `sendRelayEvent?: (channel, payload) => void`, optional test-only `retryServiceFactory` / `resumeServiceFactory`.
  - Export `async function runPostActivationBranch(opts): Promise<DispatchOutcome>`.
  - Internal `defaultRetryFactory` = `({logger, sendRelayEvent}) => new PostActivationRetryService({logger, sendRelayEvent})`.
  - Internal `defaultResumeFactory` = `({logger, sendRelayEvent}) => new BootResumeService({logger, sendRelayEvent})`.
  - Decision matrix per data-model.md §`runPostActivationBranch — internal flow`:
    1. `state.needsRetry` → `logger.info('Post-activation incomplete on restart — triggering retry')`; `retryService.triggerPostActivationRetry().catch(err => logger.error({err}, 'Post-activation retry failed'))`; return `'retry'`.
    2. `state.activated && state.postActivationComplete` → construct resume service via factory; `resumeService.triggerBootResume().catch(err => logger.error({err}, 'Boot resume failed'))`; return `'resume'`.
    3. Otherwise → return `'noop'` (no log line, no dispatch).
  - **MUST NOT** `await` `triggerPostActivationRetry()` / `triggerBootResume()` — fire-and-forget preserved (contract invariant #2).
  - **MUST NOT** wrap `checkPostActivationState()` in `try/catch` (contract §Error handling).

## Phase 2: Wire helper into both `server.ts` branches

- [X] T002 [US1] Refactor env-key branch in `packages/orchestrator/src/server.ts` (~L470-503, following `initializeRelayBridge()` + `detectIdentitySplit(...)`). Replace the existing inline `new PostActivationRetryService(...)` + `checkPostActivationState()` + `if (needsRetry) / else if (activated && postActivationComplete)` block with a single call:
  ```ts
  await runPostActivationBranch({
    logger: server.log,
    sendRelayEvent: relayClientRef
      ? (channel, payload) => relayClientRef!.send({ type: 'event', channel, event: payload, timestamp: new Date().toISOString() } as unknown as RelayMessage)
      : undefined,
  });
  ```
  Preserve the exact `sendRelayEvent` shape used today by inlining the same `relayClientRef!.send(...)` expression. Add the import from `./services/post-activation-dispatch.js`. Remove the now-unused `PostActivationRetryService` / `BootResumeService` imports if no other reference remains in this branch (verify with grep — the wizard branch's inline block still uses `PostActivationRetryService` until T003 lands).

- [X] T003 [US1] Refactor wizard branch inside `activateInBackground()` in `packages/orchestrator/src/server.ts` (~L879-896, after `detectIdentitySplit(...)`). Replace the existing retry-only block with the same helper call:
  ```ts
  await runPostActivationBranch({
    logger: server.log,
    sendRelayEvent: localRelayClient
      ? (channel, payload) => localRelayClient!.send({ type: 'event', channel, event: payload, timestamp: new Date().toISOString() } as unknown as RelayMessage)
      : undefined,
  });
  ```
  Note the underlying variable is `localRelayClient` (not `relayClientRef`) — but the shape passed to the helper is identical (contract invariant #4). Delete the leftover inline `PostActivationRetryService` construction, `checkPostActivationState()` call, and `if (needsRetry)` guard. After this task, `PostActivationRetryService` and `BootResumeService` are imported *only* by `post-activation-dispatch.ts` — remove their direct imports from `server.ts` if unreferenced.

## Phase 3: Load-bearing regression test (per Q3→A, SC-003)

- [X] T004 [US1] Create `packages/orchestrator/src/__tests__/server-boot-resume-wizard-branch.test.ts`. Mirror the mock scaffolding from `server-background-activation.test.ts` (see data-model.md §Test surface):
  - `vi.mock('../activation/index.js', () => ({ activate: vi.fn() }))`.
  - `vi.mock('@generacy-ai/cluster-relay', ...)` — stub `ClusterRelayClient` constructor.
  - `vi.mock('@generacy-ai/control-plane', ...)` — stub `TunnelHandler`, `getCodeServerManager()` → null.
  - `vi.mock('../services/boot-resume-service.js', ...)` — spy on constructor; `triggerBootResume: vi.fn().mockResolvedValue(undefined)`.
  - `vi.mock('../services/post-activation-retry.js', ...)` — mock `checkPostActivationState` (default: `{activated: true, postActivationComplete: true, needsRetry: false}`); `triggerPostActivationRetry: vi.fn().mockResolvedValue(undefined)`.
  - Drive `createServer(config, options)` with `config.relay.apiKey` **undefined** (forces the wizard branch, `server.ts:433`).
  - Call `server.listen(...)`, `await activateMock.mock.results[0].value` (or equivalent flush), then assert:
    - **Case 1 — SC-003 guard (`triggerBootResume fires on wizard branch when state is activated + complete`)**: `BootResumeService.prototype.triggerBootResume` called exactly once; `PostActivationRetryService.prototype.triggerPostActivationRetry` NOT called.
    - **Case 2 — retry path preserved (`triggerBootResume does NOT fire when state is needsRetry`)**: swap `checkPostActivationState` mock to `{activated: true, postActivationComplete: false, needsRetry: true}`; assert retry called and resume NOT.
    - **Case 3 — first-boot noop (`triggerBootResume does NOT fire on first-boot (!activated)`)**: swap mock to `{activated: false, postActivationComplete: false, needsRetry: false}`; assert neither fires.
  - Add a top-of-file comment: "SC-003 guard — deleting the resume dispatch from `post-activation-dispatch.ts` or from the wizard branch call site MUST make Case 1 fail."

## Phase 4: Optional helper unit test (per Q3→C complement)

- [X] T005 [P] [US1] Create `packages/orchestrator/src/__tests__/post-activation-dispatch.test.ts`. Direct import of `runPostActivationBranch`; construct fake services and inject via `retryServiceFactory` / `resumeServiceFactory`. Cases from data-model.md §Test surface:
  - `retry outcome` — state `{needsRetry: true}` → outcome `'retry'`; retry called; resume not called.
  - `resume outcome` — state `{activated: true, postActivationComplete: true, needsRetry: false}` → outcome `'resume'`; resume called; retry not called.
  - `noop outcome` — state `{activated: false}` → outcome `'noop'`; neither called.
  - `retry rejection is caught + logged` — `triggerPostActivationRetry` rejects; helper still resolves to `'retry'`; `logger.error` was called with the rejection.
  - `resume rejection is caught + logged` — symmetric.
  - `nullable sendRelayEvent` — omit `sendRelayEvent`; helper dispatches without throwing.
  No filesystem / no sockets / no Fastify — pure unit.

## Phase 5: Validation

- [X] T006 [US1] Run `pnpm --filter @generacy-ai/orchestrator typecheck` and `pnpm --filter @generacy-ai/orchestrator test` (or the repo's canonical equivalents). Verify:
  - Typecheck passes.
  - T004 test file passes end-to-end.
  - If T005 was landed: T005 tests pass.
  - Existing tests (`server-background-activation.test.ts`, `post-activation-retry.test.ts`, `boot-resume-service.test.ts`) still pass unchanged.
- [ ] T007 [US1] Manual smoke per `specs/834-summary-824-fix-auto/quickstart.md`: `generacy stop <wizard-cluster>` then `generacy start <wizard-cluster>`; confirm `"Boot resume: waiting for control-plane socket"` log line appears; confirm a `code tunnel` process exists after restart; confirm the VS Code tunnel reconnects on the cloud UI. (Skip if no wizard cluster is available in the reviewer's environment — T004 is the load-bearing regression coverage.)

## Dependencies & Execution Order

**Sequential dependency chain**:
1. **T001** (helper module) — must land before **T002** and **T003** (both `server.ts` branches import the helper).
2. **T002** and **T003** — must both land in the same commit as **T001** (typecheck-atomic: leaving one branch on the old inline shape while the other uses the helper leaves imports dangling).
3. **T004** — load-bearing regression test, depends on T001–T003 to pass (with all three landed, Case 1 must pass; without T003 landed, Case 1 must fail — this is SC-003 in action).
4. **T005** — optional, `[P]` with T004 (different file, no shared state; pure-unit helper coverage).
5. **T006** — depends on T001–T004 (T005 optional).
6. **T007** — depends on T006 passing; requires a live wizard cluster.

**Parallel opportunities**:
- **T005 [P]** parallel with T004 (different files, both consume the T001 helper via imports).
- No other tasks are safely parallelizable — T002/T003 both edit `server.ts` and share import cleanup.

**Total task count**: 7 tasks (1 new module, 1 modified `server.ts`, 1 load-bearing test, 1 optional unit test, 2 validation).
**Phase breakdown**: 5 phases (helper → wiring → regression test → optional unit test → validation).
**Parallel opportunities**: T005 in parallel with T004.
