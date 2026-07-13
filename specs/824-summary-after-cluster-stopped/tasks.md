# Tasks: Orchestrator boot-time service resume (VS Code tunnel + code-server)

**Input**: Design documents from `/specs/824-summary-after-cluster-stopped/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/service-contract.md, quickstart.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = orchestrator boot-time service resume)

## Phase 1: Core Service Implementation

- [X] T001 [US1] Create `packages/orchestrator/src/services/boot-resume-service.ts` with the module skeleton: imports (`node:http`, `FastifyBaseLogger`, `probeControlPlaneSocket` from `./control-plane-probe.js`), the `ResumeServiceKind` type union (`'vscode-tunnel' | 'code-server'`, module-local), the exported `BootResumeOptions` interface (mirror `PostActivationRetryOptions` minus `completionFlagPath`/`keyFilePath`), and default constants (`DEFAULT_SOCKET = '/run/generacy-control-plane/control.sock'`, `DEFAULT_WAIT_TIMEOUT = 15`). Contract: `contracts/service-contract.md` §Class surface; data model: `data-model.md` §Types introduced. Do NOT import `StatusReporter` — per Decision 3, resume does not push cluster.status transitions.

- [X] T002 [US1] In `packages/orchestrator/src/services/boot-resume-service.ts`, add the `BootResumeService` class skeleton: constructor stores `controlPlaneSocket`, `controlPlaneWaitTimeout`, `logger`, and nullable `sendRelayEvent` from options; declare private helper stubs `waitForControlPlane()`, `sendLifecycleAction(service: ResumeServiceKind)`, and `handleResumeFailure(service: ResumeServiceKind, error: string)`. Mirrors `PostActivationRetryService` constructor shape (`packages/orchestrator/src/services/post-activation-retry.ts:28-45`) without the `statusReporter` field.

- [X] T003 [US1] In `packages/orchestrator/src/services/boot-resume-service.ts`, implement `private async waitForControlPlane(): Promise<boolean>` using the same 1 s-poll-up-to-`controlPlaneWaitTimeout`-seconds loop as `post-activation-retry.ts:68-73`. Reuses `probeControlPlaneSocket(this.controlPlaneSocket)`. Returns `true` on ready, `false` on timeout. Log via `this.logger.info` at start; log via `this.logger.error` on timeout with the elapsed timeout value.

- [X] T004 [US1] In `packages/orchestrator/src/services/boot-resume-service.ts`, implement `private sendLifecycleAction(service: ResumeServiceKind): Promise<void>` — port `post-activation-retry.ts:106-147` with three edits: (1) `body = JSON.stringify({ action: '${service}-start' })`; (2) `path = '/lifecycle/${service}-start'`; (3) `x-generacy-actor-session-id` header is `'boot-resume'` (not `'post-activation-retry'`). Same 10 s `req.setTimeout`, same 2xx→resolve / non-2xx→reject-with-`Lifecycle action returned ${status}: ${body}` shape. See wire-level examples in `contracts/service-contract.md` §Wire-level.

- [X] T005 [US1] In `packages/orchestrator/src/services/boot-resume-service.ts`, implement `private handleResumeFailure(service: ResumeServiceKind, error: string): void`. Emits `this.sendRelayEvent?.('cluster.bootstrap', { status: 'failed', reason: 'resume-failed', service, error })`. Does NOT call `StatusReporter.pushStatus` (Decision 3 divergence from sibling; contract invariant I3). Does NOT throw (invariant I4). Log via `this.logger.error({ service, error }, 'Boot resume: lifecycle-action-failed')`.

- [X] T006 [US1] In `packages/orchestrator/src/services/boot-resume-service.ts`, implement `public async triggerBootResume(): Promise<void>`. Flow (per `data-model.md` §BootResumeService.triggerBootResume() internal flow):
  1. `this.logger.info('Boot resume: waiting for control-plane socket')`
  2. `const ready = await this.waitForControlPlane()`
  3. If `!ready`: call `this.handleResumeFailure('vscode-tunnel', 'Control-plane socket did not become ready')` **then** `this.handleResumeFailure('code-server', 'Control-plane socket did not become ready')` (stable order, invariant I5) and `return`. No POSTs fire.
  4. Otherwise, `this.logger.info('Boot resume: control-plane ready — dispatching lifecycle actions')` then `await Promise.allSettled([this.sendLifecycleAction('vscode-tunnel').catch(err => this.handleResumeFailure('vscode-tunnel', err instanceof Error ? err.message : String(err))), this.sendLifecycleAction('code-server').catch(err => this.handleResumeFailure('code-server', err instanceof Error ? err.message : String(err)))])`. Log `this.logger.info('Boot resume: both lifecycle actions dispatched')` on completion. NEVER throw (invariant I4).

## Phase 2: Unit Tests

- [X] T007 [P] [US1] Create `packages/orchestrator/src/__tests__/boot-resume-service.test.ts` scaffolding: mirror `post-activation-retry.test.ts` imports (`vitest`, `net`, `node:fs`, `node:path`, `node:os`, silent-logger fixture) and shared setup (temp unix-socket path in a `beforeEach` scratch dir, `net.createServer` mock harness that captures method/path/body/headers and returns configurable status). No test cases yet — just the `describe('BootResumeService')` block, `beforeEach`/`afterEach` hooks, and a request-counter map keyed by path. Model on `post-activation-retry.test.ts:1-100`.

- [X] T008 [P] [US1] In `packages/orchestrator/src/__tests__/boot-resume-service.test.ts`, add happy-path test (`describe('triggerBootResume — happy path')`): configure the mock socket to return 200 for both `/lifecycle/vscode-tunnel-start` and `/lifecycle/code-server-start`; assert both POST paths were hit exactly once, both bodies were `{"action":"vscode-tunnel-start"}` / `{"action":"code-server-start"}`, and captured `sendRelayEvent` mock received zero `cluster.bootstrap` events. Verifies contract §Nominal.

- [X] T009 [P] [US1] In `packages/orchestrator/src/__tests__/boot-resume-service.test.ts`, add partial-failure tests (`describe('triggerBootResume — partial failure')`): (a) tunnel returns 500, code-server returns 200 — assert code-server POST WAS made, exactly one `cluster.bootstrap { service: 'vscode-tunnel', reason: 'resume-failed' }` event emitted, `triggerBootResume()` resolves without throw; (b) symmetric — code-server returns 500, tunnel returns 200. Verifies contract §Partial failure and invariant I1 (independent POSTs).

- [X] T010 [P] [US1] In `packages/orchestrator/src/__tests__/boot-resume-service.test.ts`, add both-fail test (`describe('triggerBootResume — both fail')`): both endpoints return 500; assert BOTH POSTs fired (Promise.allSettled semantics), two `cluster.bootstrap { reason: 'resume-failed' }` events emitted with distinct `service` values ('vscode-tunnel' and 'code-server'), `triggerBootResume()` resolves. Verifies contract §Total failure.

- [X] T011 [P] [US1] In `packages/orchestrator/src/__tests__/boot-resume-service.test.ts`, add socket-unreachable test (`describe('triggerBootResume — socket not ready')`): construct with `controlPlaneSocket` pointing at a non-existent path and `controlPlaneWaitTimeout: 1` (to keep test fast); assert no HTTP POSTs made, exactly two `cluster.bootstrap` events emitted in order `vscode-tunnel` then `code-server`, both with `error: 'Control-plane socket did not become ready'`, `triggerBootResume()` resolves. Verifies contract §Socket-unreachable and invariant I5.

- [X] T012 [P] [US1] In `packages/orchestrator/src/__tests__/boot-resume-service.test.ts`, add single-shot regression test (`describe('triggerBootResume — single-shot')`): tunnel endpoint returns 500; assert the request counter for `/lifecycle/vscode-tunnel-start` === 1 (not 2, not 3). Verifies contract invariant I2 (no retry loop).

- [X] T013 [P] [US1] In `packages/orchestrator/src/__tests__/boot-resume-service.test.ts`, add nullable-callback test (`describe('triggerBootResume — nullable sendRelayEvent')`): construct without `sendRelayEvent`, force both POSTs to 500; assert `triggerBootResume()` resolves without throw. Regression guard for `data-model.md` §Validation ("sendRelayEvent is nullable").

## Phase 3: Server Wiring

- [X] T014 [US1] Modify `packages/orchestrator/src/server.ts` (`~L446-488` in the `else if (!isWorkerMode && config.relay.apiKey)` branch). Add `import { BootResumeService } from './services/boot-resume-service.js'` at the top (grouped with other service imports). After the existing `if (postActivationState.needsRetry) { ... }` block that fires `triggerPostActivationRetry()`, add an `else if (postActivationState.activated && postActivationState.postActivationComplete) { ... }` branch that instantiates `BootResumeService` with `{ logger: server.log, sendRelayEvent: <same relayClientRef-based callback used for retryService at L472-479> }` and calls `resumeService.triggerBootResume().catch((err) => server.log.error({ err }, 'Boot resume failed'))`. Do NOT `await` the promise (per contract §Invocation preconditions). Do NOT recompute `postActivationState` — reuse the object from L481.

## Phase 4: Validation

- [X] T015 [P] [US1] Build orchestrator package to catch TypeScript errors: `pnpm --filter @generacy-ai/orchestrator build`. Fix any type errors surfaced before proceeding to test runs.

- [X] T016 [P] [US1] Run the new test file in isolation: `pnpm --filter @generacy-ai/orchestrator test src/__tests__/boot-resume-service.test.ts`. All 7 test cases from Phase 2 (T007–T013) must pass.

- [X] T017 [P] [US1] Run the sibling test file as a regression check: `pnpm --filter @generacy-ai/orchestrator test src/__tests__/post-activation-retry.test.ts`. Must still pass unchanged — this feature does not touch `PostActivationRetryService`.

- [X] T018 [US1] Run the full orchestrator test suite: `pnpm --filter @generacy-ai/orchestrator test`. Must pass; watch for any incidental breakage in server-integration tests that touch the `else if` branch we added in T014.

- [ ] T019 [US1] Manual repro against a live local cluster per `quickstart.md` §Case 1 (clean stop/start cycle): `generacy stop` → `generacy up`, then `docker compose ... exec orchestrator ps -ef | grep 'code tunnel'` — confirm the `code tunnel` process is present and the cloud project page shows the tunnel connected within 60 s. Verifies SC-001.

## Dependencies & Execution Order

**Sequential within Phase 1** (T001 → T002 → T003 → T004 → T005 → T006): each task builds on the previous inside the same file. Skipping ahead risks referencing symbols that don't yet exist.

**Phase 2 tests (T007–T013) parallelizable [P] AMONG EACH OTHER** once the scaffolding (T007) exists. T008–T013 all add independent `describe(...)` blocks to the same file; they cannot literally be run in parallel by the same agent, but the ordering doesn't matter. If splitting across agents, share the scaffolding first (T007), then divvy up test cases.

**Phase 2 must complete after Phase 1** — the tests import `BootResumeService`, which doesn't exist until T001–T006 land. Reversing the order (TDD-style: write tests first, then make them pass) is also valid; if pursued, T007–T013 land as failing tests, then T001–T006 turn them green.

**Phase 3 (T014) depends on Phase 1** completion (the class must exist to be imported and instantiated). Phase 3 does NOT need to wait for Phase 2 tests to pass — server.ts wiring is a distinct file and TypeScript will catch the shape mismatch either way.

**Phase 4 validation (T015–T019) runs AFTER Phase 1, 2, 3** all land. T015 (build) can run in parallel with T016 (new tests) once both phases are code-complete. T017 (sibling regression) is fully parallel with T015 and T016. T018 (full suite) should come after T015 to avoid noisy compile errors. T019 (manual repro) is optional if the team requires it before merge; otherwise it happens in CI via the existing e2e paths.

**Parallel opportunities**:
- Test cases (T008–T013) can be authored by different reviewers/pairs concurrently once T007 lands.
- Build (T015), new-file test run (T016), and sibling test run (T017) are three independent processes — safe to fan out.

## Notes

- All file paths are absolute-relative to repo root `/workspaces/generacy`.
- No new dependencies, no new env vars, no schema changes, no cross-repo changes. Scope is fully contained in `packages/orchestrator`.
- Idempotency of the underlying `VsCodeTunnelProcessManager.start()` and `CodeServerProcessManager.start()` is a load-bearing assumption; if either gains non-idempotent side effects in the future, this design would need a dedup layer. Called out in `plan.md` §Structure Decision.
- Cloud-side consumer changes for the new `cluster.bootstrap { reason: 'resume-failed', service }` payload are out of scope here — the field extension is backwards-compatible per `data-model.md` §Backward compatibility.
