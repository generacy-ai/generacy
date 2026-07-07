# Implementation Plan: Wire boot-resume into the wizard (activateInBackground) startup path

**Feature**: Fix #824's mis-wiring so `BootResumeService.triggerBootResume()` runs on wizard-provisioned clusters after stop/start, not just on env-key clusters (issue #834)
**Branch**: `834-summary-824-fix-auto`
**Status**: Complete
**Date**: 2026-07-07
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Input**: Feature specification at `/specs/834-summary-824-fix-auto/spec.md`

## Summary

`createServer()` in `packages/orchestrator/src/server.ts` has two mutually-exclusive startup branches, chosen on whether `config.relay.apiKey` is populated at boot:

- **Env-key branch** (`server.ts:447`, `else if (!isWorkerMode && config.relay.apiKey)`) — used when the relay API key is present in the process env at start-time. This branch fully implements the post-activation decision matrix: `PostActivationRetryService` runs `checkPostActivationState()` and calls `triggerPostActivationRetry()` on `needsRetry`, then a new `else if (activated && postActivationComplete)` (added by #824 / PR #832) constructs `BootResumeService` and calls `triggerBootResume()`.
- **Wizard branch** (`server.ts:433`, `if (!isWorkerMode && !config.relay.apiKey)`) — used when the key is persisted to `/var/lib/generacy/cluster-api-key` and reloaded during activation, i.e. every wizard-provisioned cluster. It runs `activateInBackground(...)` which calls `initializeRelayBridge()`, then constructs `PostActivationRetryService`, calls `checkPostActivationState()`, and **only handles `needsRetry`** (`server.ts:879-896`). The `activated && postActivationComplete` case — the one that #824 exists to fix — silently no-ops.

Net: on every wizard cluster stop/start, `BootResumeService` is never constructed, the two lifecycle POSTs never fire, and the tunnel + code-server stay dead. #824 shipped correct in isolation but on the wrong branch.

**Fix (per clarifications Q1→A, Q2→A, Q3→A)**: hoist the shared "post-activation decision matrix" into a new module `packages/orchestrator/src/services/post-activation-dispatch.ts`. The helper **owns the decision** — it constructs `PostActivationRetryService` internally, calls `checkPostActivationState()`, and dispatches to retry / resume / noop. Both startup branches in `server.ts` collapse to a single `await runPostActivationBranch(...)` call site, receiving only `{ logger, sendRelayEvent }`. This makes the #824 regression impossible by construction: there is no per-branch `if/else` for a future contributor to drop half of.

Regression coverage per Q3→A (load-bearing): a new integration test drives `createServer()` down the `activateInBackground` branch (empty `config.relay.apiKey`), stubs `activate()` + control-plane socket + `PostActivationRetryService.checkPostActivationState()` to return `activated && postActivationComplete`, and asserts `BootResumeService.triggerBootResume()` (or the two `/lifecycle/*-start` POSTs) fires. SC-003: deleting the boot-resume half from the helper must make this test fail. Optional Q3→C complement: a unit test on the helper covering the full retry / resume / noop matrix.

Design constraints locked by clarifications ([clarifications.md](./clarifications.md)): Q1→A (helper owns the decision), Q2→A (new module under `services/`), Q3→A load-bearing + C optional.

Everything downstream of the helper (`PostActivationRetryService`, `BootResumeService`, control-plane, lifecycle handlers) is unchanged — this feature is purely a call-site consolidation + a regression test that would have caught #824.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >=22 (matches orchestrator engines). Compiles to ESM.
**Primary Dependencies**: None new. Reuses existing:
- `PostActivationRetryService` (`packages/orchestrator/src/services/post-activation-retry.ts`) — sibling service, unchanged.
- `BootResumeService` (`packages/orchestrator/src/services/boot-resume-service.ts`) — sibling service added by #824, unchanged.
- `FastifyBaseLogger` type — shared across all services.
- `vitest` for unit + integration tests. `vi.mock('../activation/index.js', ...)` pattern already established in `server-background-activation.test.ts` for driving the `activateInBackground` branch under test.
**Storage**: None. State remains pure runtime — no new files, sentinels, or persisted flags. `checkPostActivationState()` still reads `/var/lib/generacy/cluster-api-key` and `/var/lib/generacy/post-activation-complete` internally (unchanged).
**Testing**: `vitest` in `packages/orchestrator/src/__tests__/`. Integration test file for the wizard-branch wiring; optional unit test file for the helper's decision matrix.
**Target Platform**: Orchestrator container process (`packages/orchestrator`). Runs on every cluster restart, both local (Docker Compose) and BYO VM (`generacy deploy`). Wizard-provisioned clusters are the primary beneficiary; env-key clusters continue to work because both branches call the same helper.
**Project Type**: Single-package edit, purely internal call-site consolidation. One new module, one new test file (plus an optional second test file for helper unit coverage), one modified caller (`server.ts`).
**Performance Goals**:
- No latency change vs. #824 on env-key clusters (call site is now one function call instead of inline code — negligible overhead).
- Wizard clusters gain the same <60 s restart-to-tunnel-restored latency #824 already delivered on env-key clusters (SC-001 of #824, transitively covered).
**Constraints**:
- **Helper owns the decision** (Q1→A). Both branches invoke a single entry point; there is no per-branch retry/resume dispatch code for a future contributor to duplicate.
- **Helper lives in a new module** (Q2→A). `packages/orchestrator/src/services/post-activation-dispatch.ts`, exported and unit-testable by import without booting Fastify.
- **Regression test drives `createServer()` on the wizard branch** (Q3→A). This is the load-bearing test; SC-003 requires that removing the boot-resume dispatch from the helper (or from the wizard branch's call site) makes the test fail.
- **No changes to `PostActivationRetryService` or `BootResumeService`**. Both were correct in #824; only their wiring was wrong.
- **No control-plane changes, no lifecycle-handler changes, no relay changes, no cross-repo changes** — spec §Scope explicitly forbids these.
- **Both branches build `sendRelayEvent` to the same shape** (`relayClientRef` in env-key branch, `localRelayClient` in wizard branch, both nullable) — the helper signature is identical for both call sites (per Q1 clarification).
- **The wizard branch runs the helper *after* `initializeRelayBridge()` and the identity-split detector** — same relative ordering as the env-key branch — so `sendRelayEvent` is wired before the resume path can emit.
**Scale/Scope**: ~1 new module (~80 LOC), ~1 new integration test (~150 LOC), ~1 optional helper unit test (~80 LOC), ~1 modified file (`server.ts`, ~30 LOC net deletion from both branches replaced with a helper call). Total ~340 LOC, ~30 LOC removed from `server.ts`.

## Constitution Check

No `.specify/memory/constitution.md` present in this repo. No gates to evaluate. Constitution check **PASS** (vacuously).

## Project Structure

### Documentation (this feature)

```text
specs/834-summary-824-fix-auto/
├── spec.md                                          # already authored
├── clarifications.md                                # already authored (Batch 1, Q1–Q3)
├── plan.md                                          # THIS FILE
├── research.md                                      # decision rationale (Q1–Q3, alternatives)
├── data-model.md                                    # helper interface + call graph before/after both branches
├── quickstart.md                                    # local repro / validation for wizard-branch restart
└── contracts/
    └── helper-contract.md                           # runPostActivationBranch signature + decision matrix invariant
```

`tasks.md` is produced by `/speckit:tasks`, not this command.

### Source Code (orchestrator package — repository monorepo)

```text
packages/orchestrator/src/
├── services/
│   ├── post-activation-dispatch.ts                  # NEW — exports `runPostActivationBranch(opts)`.
│   │                                                #   Signature (see contracts/helper-contract.md):
│   │                                                #     interface DispatchOptions {
│   │                                                #       logger: FastifyBaseLogger;
│   │                                                #       sendRelayEvent?: (channel: string, payload: unknown) => void;
│   │                                                #       // Optional injection seams for unit tests (defaults preserve prod behavior):
│   │                                                #       retryServiceFactory?: (deps) => PostActivationRetryService;
│   │                                                #       resumeServiceFactory?: (deps) => BootResumeService;
│   │                                                #     }
│   │                                                #     async function runPostActivationBranch(opts): Promise<DispatchOutcome>
│   │                                                #   Body:
│   │                                                #     const retryService = (opts.retryServiceFactory ?? defaultRetryFactory)({
│   │                                                #       logger: opts.logger,
│   │                                                #       sendRelayEvent: opts.sendRelayEvent,
│   │                                                #     });
│   │                                                #     const state = retryService.checkPostActivationState();
│   │                                                #     if (state.needsRetry) {
│   │                                                #       opts.logger.info('Post-activation incomplete on restart — triggering retry');
│   │                                                #       retryService.triggerPostActivationRetry().catch(
│   │                                                #         (err) => opts.logger.error({ err }, 'Post-activation retry failed'),
│   │                                                #       );
│   │                                                #       return { outcome: 'retry' };
│   │                                                #     }
│   │                                                #     if (state.activated && state.postActivationComplete) {
│   │                                                #       const resumeService = (opts.resumeServiceFactory ?? defaultResumeFactory)({
│   │                                                #         logger: opts.logger,
│   │                                                #         sendRelayEvent: opts.sendRelayEvent,
│   │                                                #       });
│   │                                                #       resumeService.triggerBootResume().catch(
│   │                                                #         (err) => opts.logger.error({ err }, 'Boot resume failed'),
│   │                                                #       );
│   │                                                #       return { outcome: 'resume' };
│   │                                                #     }
│   │                                                #     return { outcome: 'noop' };
│   │                                                #   Fire-and-forget semantics: helper returns after *dispatching* the
│   │                                                #   right service; it does NOT await triggerPostActivationRetry()
│   │                                                #   or triggerBootResume(). Both target functions are already
│   │                                                #   fire-and-forget in server.ts today; helper preserves that shape.
│   ├── post-activation-retry.ts                     # UNTOUCHED — helper *uses* this; interface unchanged
│   ├── boot-resume-service.ts                       # UNTOUCHED — helper *uses* this; interface unchanged
│   └── control-plane-probe.ts                       # UNTOUCHED
├── server.ts                                        # MODIFIED — both branches now call the helper.
│                                                    #   Env-key branch (~L470-503): replace the inline
│                                                    #     `new PostActivationRetryService` + `checkPostActivationState()`
│                                                    #     + `if/else if` block with a single
│                                                    #     `await runPostActivationBranch({ logger: server.log, sendRelayEvent })`
│                                                    #   Wizard branch inside activateInBackground() (~L879-896):
│                                                    #     replace the retry-only block with the same single call
│                                                    #     using `sendRelayEvent` built around `localRelayClient` instead
│                                                    #     of `relayClientRef`. Same helper, same signature, same
│                                                    #     invocation shape.
└── __tests__/
    ├── server-boot-resume-wizard-branch.test.ts     # NEW (LOAD-BEARING per Q3→A) — drives createServer() with
    │                                                #   config.relay.apiKey = undefined so wizard branch runs;
    │                                                #   mocks `../activation/index.js` (activate) + cluster-relay +
    │                                                #   control-plane package (same pattern as
    │                                                #   server-background-activation.test.ts);
    │                                                #   injects `retryServiceFactory` / `resumeServiceFactory` fakes
    │                                                #   into runPostActivationBranch via module-level test hook
    │                                                #   (see helper-contract.md §Test injection);
    │                                                #   stubs checkPostActivationState() → { activated: true,
    │                                                #   postActivationComplete: true, needsRetry: false };
    │                                                #   asserts a spy on BootResumeService.triggerBootResume was
    │                                                #   called exactly once after activation resolves.
    │                                                #   SC-003 guard: deleting the resume-half from the helper
    │                                                #   makes this test fail.
    ├── post-activation-dispatch.test.ts             # NEW (OPTIONAL, Q3→C complement) — pure-unit test on the
    │                                                #   helper, importing it directly:
    │                                                #     - state.needsRetry === true → triggerPostActivationRetry fires,
    │                                                #       triggerBootResume does NOT fire; outcome === 'retry'
    │                                                #     - state.activated && state.postActivationComplete → resume fires;
    │                                                #       retry does NOT fire; outcome === 'resume'
    │                                                #     - state.activated && !state.postActivationComplete (== needsRetry)
    │                                                #       already covered above (guarded by needsRetry === true first)
    │                                                #     - !state.activated → outcome === 'noop'; neither fires
    │                                                #     - triggerBootResume rejection → caught + logged, does NOT throw
    │                                                #     - triggerPostActivationRetry rejection → caught + logged, does
    │                                                #       NOT throw
    │                                                #   No server, no relay, no sockets — direct import.
    ├── server-background-activation.test.ts         # UNTOUCHED — sibling test for the wizard-branch activation
    │                                                #   scaffolding; new test copies its mock patterns
    ├── post-activation-retry.test.ts                # UNTOUCHED
    └── boot-resume-service.test.ts                  # UNTOUCHED

# NOT touched:
packages/control-plane/src/routes/lifecycle.ts       # unchanged
packages/control-plane/src/services/vscode-tunnel-manager.ts     # unchanged
packages/control-plane/src/services/code-server-manager.ts       # unchanged
packages/cluster-relay/**                            # unchanged
```

**Structure Decision**: One new module (`post-activation-dispatch.ts`) that owns the retry/resume/noop decision, plus the two `server.ts` call sites collapsed to identical one-liners. This is the shape that makes the #824 regression impossible by construction (Q1→A rationale): the helper contains the entire decision matrix, so a future contributor cannot "add a fix to one branch while leaving the other silently broken" — there is only one place to add or change the decision, and both branches share it.

**Why a new module and not a nested function in `server.ts`** (Q2→A): unit-testability. A nested function can only be exercised via `createServer()`, coupling helper tests to Fastify boot; an exported module can be imported and unit-tested standalone. Also consistent with the existing pattern — `PostActivationRetryService` and `BootResumeService` both live in `services/`; this is their natural sibling.

**Why the helper takes only `{ logger, sendRelayEvent }` and not the two services** (from Q1 rationale): both branches already build `sendRelayEvent` to the same shape (a nullable function derived from `relayClientRef` or `localRelayClient`); the helper does not need to know which relay-client variable underlies it. Constructing the services *inside* the helper (via defaultable factories for test injection) keeps the call sites identical between the two branches. The factory-injection seam (see `helper-contract.md`) exists purely for the optional unit test — prod code passes no factories.

**Why fire-and-forget (helper does not await service Promises)**: both target functions (`triggerPostActivationRetry`, `triggerBootResume`) already run as `.catch(logger)` fire-and-forget promises in `server.ts` today. Preserving that shape means the helper does not block `createServer()` — the caller does not need to know whether the helper dispatched a retry, a resume, or a noop. Server startup semantics are unchanged.

**Why the env-key branch's `else if (activated && postActivationComplete)` guard is preserved verbatim inside the helper**: preserves today's behavior for the `!activated || (activated && !postActivationComplete && !needsRetry)` corner cases (the latter is unreachable given `needsRetry === activated && !postActivationComplete`, but the guard keeps intent explicit). The helper is a code move, not a semantics change.

**Why not consolidate `activateInBackground` into the sync branch entirely**: that would restructure boot flow far beyond the scope of #834. The two branches exist for a real reason (wizard mode must not block `server.listen()`, per #567). Fixing the mis-wiring within the existing two-branch structure is the minimum change to close the regression.

## Complexity Tracking

> No constitution violations. Table omitted.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _none_   | _n/a_      | _n/a_                                |
