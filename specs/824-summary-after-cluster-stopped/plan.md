# Implementation Plan: Orchestrator boot-time service resume (VS Code tunnel + code-server)

**Feature**: Orchestrator boot-time resume of VS Code tunnel and code-server after cluster stop/start (issue #824)
**Branch**: `824-summary-after-cluster-stopped`
**Status**: Complete
**Date**: 2026-07-07
**Spec**: [spec.md](./spec.md)
**Input**: Feature specification at `/specs/824-summary-after-cluster-stopped/spec.md`

## Summary

`generacy stop` explicitly stops the VS Code tunnel and code-server (via `vscode-tunnel-stop` + `code-server-stop` lifecycle actions). On the subsequent `generacy start`, neither service ever restarts, because their sole auto-start site — the control-plane `bootstrap-complete` lifecycle handler — is only *replayed* by the orchestrator when `PostActivationRetryService.checkPostActivationState()` returns `needsRetry === true`. On a healthy already-activated cluster the state is `activated && postActivationComplete`, so `needsRetry === false` and no replay fires. Fix: add an orchestrator-side **boot-resume** step in the same block, running **after** `initializeRelayBridge()` (matches the sibling retry service's ordering), that fires two independent, best-effort lifecycle POSTs:

- `POST /lifecycle/vscode-tunnel-start` on the control-plane socket
- `POST /lifecycle/code-server-start` on the control-plane socket

Each call reuses the same envelope as `PostActivationRetryService.triggerPostActivationRetry()`: 15 s `probeControlPlaneSocket` wait + 1 POST attempt with a 10 s request timeout. Failures are surfaced on the `cluster.bootstrap` relay channel with `{ status: 'failed', reason: 'resume-failed', service: 'vscode-tunnel' | 'code-server', error }`, mirroring `handleRetryFailure`. Success/no-op paths are silent (per-service success signals still flow through `cluster.vscode-tunnel` and `codeServerReady` metadata as they do on first boot).

Control-plane, `bootstrap-complete`, and the sibling retry path are all untouched. Both service managers (`VsCodeTunnelProcessManager.start()`, `CodeServerProcessManager.start()`) are already idempotent, so this is safe even if a future path also triggers a start.

Design decisions locked by clarifications ([clarifications.md](./clarifications.md)): Q1→A (orchestrator-side), Q2→A (independent, best-effort), Q3→B (reuse `cluster.bootstrap`), Q4→A (single-shot), Q5→A (after relay bridge).

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >=22 (matches orchestrator engines). Compiles to ESM.
**Primary Dependencies**: None new. Reuses existing:
- `probeControlPlaneSocket` (`packages/orchestrator/src/services/control-plane-probe.ts`) for 15 s socket wait.
- `node:http` `request({ socketPath, ... })` for lifecycle POSTs — identical to `PostActivationRetryService.sendLifecycleAction`.
- Existing `sendRelayEvent` callback wired around `relayClientRef` in `server.ts` for relay emission.
- `LifecycleActionSchema` in `packages/control-plane/src/schemas.ts` already includes both `vscode-tunnel-start` and `code-server-start` — no schema change.
**Storage**: None. State is pure runtime; no new files, sentinels, or persisted flags.
**Testing**: `vitest` in `packages/orchestrator/src/__tests__/`. New unit tests for the resume service (mirroring `post-activation-retry.test.ts` shape). No integration or e2e additions — quickstart doc provides manual repro.
**Target Platform**: Orchestrator container process (`packages/orchestrator`). Runs on every cluster restart, both local (Docker Compose) and BYO VM (`generacy deploy`).
**Project Type**: Single-package edit. One new service file, one new test file, one modified caller (`server.ts`).
**Performance Goals**:
- SC-001 target (<60 s from `generacy start` to tunnel restored): met by 15 s socket-wait ceiling + ~1 s POST + ~5 s device-token attach in the tunnel-manager child process. Well under budget.
- The two POSTs run concurrently (via `Promise.allSettled`), so total wall-clock is bounded by the slower of the two, not their sum.
**Constraints**:
- **Single-shot**, no bounded retry / no background watcher (Q4→A). UI Restart is the manual backstop.
- **Independent failures**: neither POST awaits or short-circuits on the other (Q2→A). Enforced via `Promise.allSettled`.
- **Runs after `initializeRelayBridge()`** so `cluster.vscode-tunnel { status: 'starting' }` events reach the cloud on the very first tunnel-manager emit (Q5→A).
- **Control-plane untouched**. Policy of "when to auto-start on restart" lives with the orchestrator, next to `checkPostActivationState()`. Consistent with Q1→A rationale.
- **Executes in the `needsRetry === false && activated && postActivationComplete` branch only**. When `needsRetry === true`, the sibling retry service already POSTs `bootstrap-complete`, which itself starts both services — resume must NOT double-fire (idempotency of `start()` makes double-fire safe, but skipping is the cleaner mental model).
**Scale/Scope**: ~1 new file (`boot-resume-service.ts`, est. ~120 LOC), ~1 new test file (est. ~150 LOC), 1 modified file (`server.ts`, ~15 LOC diff). Total ~285 LOC + tests.

## Constitution Check

No `.specify/memory/constitution.md` present in this repo. No gates to evaluate. Constitution check **PASS** (vacuously).

## Project Structure

### Documentation (this feature)

```text
specs/824-summary-after-cluster-stopped/
├── spec.md                                          # already authored
├── clarifications.md                                # already authored (Batch 1, Q1–Q5)
├── plan.md                                          # THIS FILE
├── research.md                                      # decision rationale
├── data-model.md                                    # types + call graph deltas
├── quickstart.md                                    # local repro / validation
└── contracts/
    └── service-contract.md                          # BootResumeService interface + relay event shapes
```

`tasks.md` is produced by `/speckit:tasks`, not this command.

### Source Code (orchestrator package — repository monorepo)

```text
packages/orchestrator/src/
├── services/
│   ├── boot-resume-service.ts                       # NEW — BootResumeService class. Mirrors PostActivationRetryService shape:
│   │                                                #   - constructor takes { logger, sendRelayEvent, controlPlaneSocket?, controlPlaneWaitTimeout? }
│   │                                                #   - triggerBootResume() waits for control-plane socket, then Promise.allSettled([
│   │                                                #       sendLifecycleAction('vscode-tunnel-start'),
│   │                                                #       sendLifecycleAction('code-server-start'),
│   │                                                #     ])
│   │                                                #   - per-service failure emits cluster.bootstrap { status: 'failed', reason: 'resume-failed', service, error }
│   ├── post-activation-retry.ts                     # UNTOUCHED — the sibling; still runs when needsRetry === true
│   ├── control-plane-probe.ts                       # UNTOUCHED — probeControlPlaneSocket reused verbatim
│   └── status-reporter.ts                           # UNTOUCHED — resume does NOT push cluster status transitions
├── server.ts                                        # MODIFIED — in the existing "existing API key" branch (~L446-488),
│                                                    # after PostActivationRetryService runs, gain a new `else`:
│                                                    #   if (needsRetry) { ... existing ... }
│                                                    #   else if (activated && postActivationComplete) {
│                                                    #     const resumeService = new BootResumeService({ logger, sendRelayEvent: ... });
│                                                    #     resumeService.triggerBootResume().catch(err => logger.error({ err }, 'Boot resume failed'));
│                                                    #   }
└── __tests__/
    ├── boot-resume-service.test.ts                  # NEW — mirrors post-activation-retry.test.ts:
    │                                                #   - both POSTs fire on healthy path
    │                                                #   - tunnel 5xx does NOT prevent code-server POST
    │                                                #   - code-server 5xx does NOT prevent tunnel POST
    │                                                #   - both 5xx emit two independent cluster.bootstrap events
    │                                                #   - socket-not-ready after 15 s emits both events + no POSTs fired
    │                                                #   - single-shot: no retry on 5xx
    └── post-activation-retry.test.ts                # UNTOUCHED

# UNTOUCHED — control-plane executes lifecycle actions; policy stays in orchestrator
packages/control-plane/src/routes/lifecycle.ts       # both vscode-tunnel-start and code-server-start branches already exist
packages/control-plane/src/services/vscode-tunnel-manager.ts    # VsCodeTunnelProcessManager.start() is idempotent
packages/control-plane/src/services/code-server-manager.ts      # CodeServerProcessManager.start() is idempotent
```

**Structure Decision**: One new sibling service class next to `PostActivationRetryService`. The two services share ~90% of their implementation shape (socket probe + POST + relay emit on failure), but stay separate rather than being refactored into a shared base:

- The **when-to-fire predicate** is inverted (`needsRetry === true` vs `needsRetry === false && activated && postActivationComplete`) and lives in the caller (`server.ts`), not the service.
- The **payload** differs (one POST to `/lifecycle/bootstrap-complete` vs two parallel POSTs to `/lifecycle/vscode-tunnel-start` and `/lifecycle/code-server-start`).
- The **relay reason discriminator** differs (`post-activation-incomplete` vs `resume-failed` with a per-service field).
- The **status-reporter side-effect** differs (post-activation retry pushes `cluster.state = degraded` on failure; boot-resume does not — a failed tunnel restart is not a cluster-degraded condition, per Q3 and Q2 discussion).

Extracting a shared `LifecycleActionInvoker` helper is tempting but premature — two callers with divergent payloads and failure semantics is exactly the "three similar lines is better than a premature abstraction" trap called out in project instructions. Revisit if a third boot-time lifecycle-poster appears.

**Why the resume lives in `server.ts` startup, not `initializeRelayBridge()`**: relay-bridge init is a plumbing step; policy decisions ("what to resume on restart") belong at the boot-flow level next to their sibling policy (`checkPostActivationState`). Keeps `initializeRelayBridge()` reusable and single-purpose.

**Why not merge into `PostActivationRetryService` with a mode flag**: same reason — inverted predicate + different payload + different side-effects. A mode flag would blur two distinct responsibilities.

**Why not touch control-plane's `bootstrap-complete` handler**: it is *idempotent* and already the correct executor of "start both services." Making orchestrator call the individual per-service actions rather than a full `bootstrap-complete` avoids re-running the sentinel write, `writeWizardEnvFile()`, peer-repo clone, and other one-shot bootstrap side-effects that don't need to repeat on restart. Q1→A rationale: control-plane stays a pure executor.

## Complexity Tracking

> No constitution violations. Table omitted.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _none_   | _n/a_      | _n/a_                                |
