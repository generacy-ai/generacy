# Tasks: Fix `codeServerReady` Cross-Process Singleton Bug

**Input**: Design documents from `/specs/596-symptoms-after-bootstrap/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: Core Implementation

- [X] T001 [US1] Create `packages/orchestrator/src/services/code-server-probe.ts` — shared async unix socket probe helper. Export `probeCodeServerSocket(socketPath?, timeoutMs?): Promise<boolean>` using `node:net`. Default socket path from `CODE_SERVER_SOCKET_PATH` env or `/run/generacy-control-plane/code-server.sock`. Default timeout 500ms. Resolve `true` on connect (then `sock.end()`), `false` on error or timeout (then `sock.destroy()`).

- [X] T002 [US1] Modify `packages/orchestrator/src/routes/health.ts` — replace `getCodeServerManager()?.getStatus() === 'running'` (~line 87) with `await probeCodeServerSocket()`. Update import: remove `getCodeServerManager` from `@generacy-ai/control-plane` (if no other usages remain), add import of `probeCodeServerSocket` from `../services/code-server-probe.js`.

- [X] T003 [US1] Modify `packages/orchestrator/src/services/relay-bridge.ts` — replace `getCodeServerManager()?.getStatus() === 'running'` (~line 501) with `await probeCodeServerSocket()`. Make `collectMetadata()` async (`async collectMetadata(): Promise<ClusterMetadata>`). Make `sendMetadata()` async (`async sendMetadata(): Promise<void>`). Update the `setInterval` callback to handle async: `setInterval(() => { this.sendMetadata().catch(err => logger.warn(...)); }, ...)`. Update import: remove `getCodeServerManager`, add `probeCodeServerSocket` from `./code-server-probe.js`.

## Phase 2: Tests

- [X] T004 [P] [US1] Create `packages/orchestrator/tests/unit/services/code-server-probe.test.ts` — unit tests for the probe helper. Test cases: (1) returns `true` when socket accepts connection, (2) returns `false` on ECONNREFUSED, (3) returns `false` on timeout, (4) returns `false` when socket file doesn't exist. Use a real `net.createServer` on a tmp unix socket for the success case; trigger errors via non-existent paths.

- [X] T005 [P] [US1] Update `packages/orchestrator/src/__tests__/health-code-server.test.ts` (or equivalent health test file) — mock `probeCodeServerSocket` instead of `getCodeServerManager`. Verify `/health` returns `codeServerReady: true` when probe resolves `true`, and `codeServerReady: false` when probe resolves `false`.

- [X] T006 [P] [US1] Update relay-bridge metadata tests (if they exist at `packages/orchestrator/tests/unit/services/relay-bridge-metadata.test.ts` or similar) — mock `probeCodeServerSocket`, verify `collectMetadata()` is now async and returns correct `codeServerReady` value from probe.

## Phase 3: Verification

- [X] T007 [US1] Run full test suite (`pnpm test` or relevant subset) and fix any failures introduced by the async signature changes.

## Dependencies & Execution Order

- **T001** must complete first (provides the shared helper)
- **T002** and **T003** depend on T001 but can run in parallel with each other
- **T004**, **T005**, **T006** depend on their respective implementation tasks but can all run in parallel with each other
- **T007** runs last after all implementation and test tasks

```
T001 ──→ T002 ──→ T005 ──→ T007
     └─→ T003 ──→ T006 ──↗
              T004 ──────↗
```
