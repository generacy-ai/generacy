# Tasks: VS Code Desktop tunnel hangs on "Starting tunnel…"

**Input**: Design documents from `/specs/966-summary-freshly-deployed/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/retained-tunnel-event.md, contracts/vscode-tunnel-manager.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = surface device code; US2 = never miss a transition across reconnect)

## Phase 1: Setup

- [X] T001 Add changeset at `.changeset/966-vscode-tunnel-retained-event.md`. Bump level `patch` on both `@generacy-ai/orchestrator` and `@generacy-ai/control-plane`. One-line summary references the retained-event replay + auth-phase timeout fix. Required by `.github/workflows/changeset-bot.yml` — the diff touches non-test files under both `packages/orchestrator/src/` and `packages/control-plane/src/`.

## Phase 2: Retained-event singleton (orchestrator write path)

- [X] T002 [US2] Create `packages/orchestrator/src/routes/retained-tunnel-event.ts`. Exports per `contracts/retained-tunnel-event.md`: `RetainedStatus`, `RetainedTunnelEvent`, `getRetainedTunnelEvent`, `setRetainedTunnelEvent`, `clearRetainedTunnelEvent`, `isRetentionEligible`. Module-scoped `retained: RetainedTunnelEvent | null = null` singleton. Zod schema `RetainedTunnelEventDataSchema` with `.passthrough()`. Module-level `NON_LIFECYCLE_ERROR_MARKERS` = `['tunnel unregister timed out', 'tunnel unregister exited with code', 'tunnel unregister failed', 'tunnel name collision']` (matched with `startsWith` — see data-model.md §Non-lifecycle error markers). `setRetainedTunnelEvent` encodes the precedence table from `contracts/retained-tunnel-event.md` §setRetainedTunnelEvent (FR-005 Q3=C: terminal beats pending; among terminals, latest wins; pending never clobbers terminal). No I/O, no `this`.

- [X] T003 [P] [US2] Write `packages/orchestrator/src/__tests__/retained-tunnel-event.test.ts`. Cases: (a) full precedence matrix from `plan.md` §"Retention slot state transitions" (11 rows); (b) `isRetentionEligible` accepts `authorization_pending`/`connected`/`disconnected`/`error` (lifecycle) and rejects the 4 exact `NON_LIFECYCLE_ERROR_MARKERS` strings (FR-006, SC-005); (c) `isRetentionEligible` rejects malformed / missing `status` / non-retained statuses (`starting`, `stopped`); (d) `get`/`clear` idempotency; (e) `beforeEach` calls `clearRetainedTunnelEvent()` for isolation. Vitest, follow the style of `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` and existing `packages/orchestrator/src/routes/__tests__/internal-relay-events.test.ts`.

- [X] T004 [US2] Modify `packages/orchestrator/src/routes/internal-relay-events.ts` at the `!client.isConnected` branch (~line 43). Before the `return reply.status(204).send()`, if `event === 'cluster.vscode-tunnel'` call `isRetentionEligible(data)`; on `{ eligible: true, status }` call `setRetainedTunnelEvent({ event, data, timestamp, status })`. All other channels keep today's silent-drop behavior. Do NOT change the `client.isConnected` `client.send(...)` happy-path branch. Import from `./retained-tunnel-event.js`.

- [X] T005 [US2] Extend `packages/orchestrator/src/routes/__tests__/internal-relay-events.test.ts` (MOD). Add cases: (a) `cluster.vscode-tunnel` + `authorization_pending` while `!isConnected` → `getRetainedTunnelEvent()` returns the event, response still 204; (b) `cluster.vscode-tunnel` while `isConnected` → forwarded via `client.send`, slot NOT populated; (c) `cluster.audit` while `!isConnected` → slot NOT populated (retention is `cluster.vscode-tunnel`-only); (d) malformed `data` (fails Zod) → slot NOT populated, still returns 204. Reset the retained slot in `beforeEach` via `clearRetainedTunnelEvent()`.

## Phase 3: Reconnect replay wiring (orchestrator read path)

- [X] T006 [US2] Modify `packages/orchestrator/src/services/relay-bridge.ts::handleConnected` (~line 197). After `setupEventForwarding()` and before `sendMetadata()`, add:
  ```ts
  const retained = getRetainedTunnelEvent();
  if (retained && this.client.isConnected) {
    this.client.send({
      type: 'event',
      event: retained.event,
      data: retained.data,
      timestamp: retained.timestamp,
    });
    clearRetainedTunnelEvent();
  }
  ```
  Fire-and-forget; wrap in try/catch and log at warn on send failure (best-effort, retention is a reliability improvement, never a correctness dependency). Import from `../routes/retained-tunnel-event.js`.

- [X] T007 [US2] Write `packages/orchestrator/src/__tests__/relay-bridge-retained-replay.test.ts`. Cases: (a) empty slot → no `client.send` call, no clear; (b) populated slot + `isConnected === true` → exactly one `client.send({ type: 'event', event: 'cluster.vscode-tunnel', … })` call with the retained payload, slot cleared afterward; (c) populated slot + `isConnected === false` at read time → no send, slot NOT cleared (survives to next reconnect). Fake `ClusterRelayClient` with toggleable `isConnected` and a `send` spy. Reset slot in `beforeEach`.

## Phase 4: VsCodeTunnelProcessManager — auth-phase timeout + fresh-emit (control-plane)

<!-- Phase boundary: T008-T011 all edit `vscode-tunnel-manager.ts`; keep sequential to avoid merge conflicts. -->

- [X] T008 [US1] In `packages/control-plane/src/services/vscode-tunnel-manager.ts`, add per `contracts/vscode-tunnel-manager.md`: (a) `export const DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS = 300_000;` (sibling to existing `DEFAULT_DEVICE_CODE_TIMEOUT_MS`, grep-adjacent); (b) `authTimeoutMs?: number` on `VsCodeTunnelManagerOptions`; (c) `private authTimer: NodeJS.Timeout | null = null;` field; (d) `private armAuthTimer(child: ChildProcess): void` and `private clearAuthTimer(): void` methods per `plan.md` §"Auth-phase timeout". `armAuthTimer` is idempotent (`if (this.authTimer) return`), reads `authTimeoutMs ?? DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS`, `unref()`s the timer, on expiry checks `this.status === 'authorization_pending'` before mutating, emits `error` with `error: "Timed out waiting for device-code authorization"` + up-to-20-line stdout tail as `details`, sets `this.timedOut = true` (routes through existing timedOut cascade), `SIGTERM`s + arms SIGKILL backstop via `forceKillTimeoutMs`.

- [X] T009 [US1] In `packages/control-plane/src/services/vscode-tunnel-manager.ts::handleStdoutLine`, at the `codeMatch && this.status === "starting"` branch (~lines 391-401), after `clearDeviceCodeTimer()` and before `emitTunnelEvent(...)`, call `this.armAuthTimer(child)`.

- [X] T010 [US1] In `packages/control-plane/src/services/vscode-tunnel-manager.ts`, add a `this.clearAuthTimer()` call at every existing `this.clearDeviceCodeTimer()` call site: exit handler (~line 191), connected transition (~line 411), `child.on('error', ...)` (~line 230), and inside `stop()` (near `clearDeviceCodeTimer()` at ~line 295). Order: `clearDeviceCodeTimer()` first (existing), `clearAuthTimer()` second (new).

- [X] T011 [US1] In `packages/control-plane/src/services/vscode-tunnel-manager.ts::start()`, extend the live-child early-return branch (~lines 143-163) with a NEW `else if` branch **inserted before** the existing `authorization_pending && deviceCode` and `connected` branches:
  ```ts
  } else if (this.status === "starting") {
    emitTunnelEvent({
      status: "starting",
      tunnelName: this.opts.tunnelName,
    });
  }
  ```
  Do NOT kill+respawn (FR-003, Q5=A). The final `return { status, tunnelName }` at ~lines 159-162 is unchanged. Ordering matters: this branch must land above the `authorization_pending && deviceCode` branch so `deviceCode == null` falls into the new branch, not through it.

- [X] T012 [US1] Extend `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` (MOD). Add cases:
    - **FR-003 (SC-004)**: with child alive, `status === "starting"`, `deviceCode == null`, calling `start()` a second time emits exactly one `starting` event via `getRelayPushEvent()` mock and does NOT invoke `spawn` a second time.
    - **FR-004 (SC-003) positive**: `authTimeoutMs: 50`, `vi.useFakeTimers()`, feed a stdout line matching the device-code regex to transition `starting → authorization_pending`, advance timers past 50 ms, assert `status === "error"`, exactly one lifecycle `error` event with `error: "Timed out waiting for device-code authorization"`, child received `SIGTERM`, exit handler does NOT double-emit.
    - **FR-004 negative**: `authTimeoutMs: 50`, transition `starting → authorization_pending → connected` before 50 ms elapses, advance timers past 50 ms, assert no `error` event, no `SIGTERM`, `authTimer` cleared.
    - **T1/T2 invariants**: after connected, both `deviceCodeTimer` and `authTimer` are null; after error/disconnected exit, both are null.

## Phase 5: Integration test (SC-002)

- [X] T013 [US2] Write `packages/orchestrator/src/__tests__/vscode-tunnel-retained-replay.integration.test.ts`. Boot the Fastify server with a stubbed `ClusterRelayClient` (mirror the pattern in existing `relay-integration.integration.test.ts`). Steps: (a) POST an `authorization_pending` event to `/internal/relay-events` while stub `isConnected === false`, assert response 204 and `getRetainedTunnelEvent()` returns the event; (b) flip stub `isConnected → true` and invoke the reconnect handler (`RelayBridge.handleConnected`); (c) assert the stub client received exactly one `send({ type: 'event', event: 'cluster.vscode-tunnel', … })` with the original payload and timestamp; (d) assert `getRetainedTunnelEvent()` is `null` post-replay. Reset the retained-event singleton in `beforeEach` via `clearRetainedTunnelEvent()`.

## Phase 6: Verification

- [X] T014 Run the full suite from repo root:
  ```bash
  pnpm --filter @generacy-ai/orchestrator test src/__tests__/retained-tunnel-event.test.ts
  pnpm --filter @generacy-ai/orchestrator test src/__tests__/relay-bridge-retained-replay.test.ts
  pnpm --filter @generacy-ai/orchestrator test src/routes/__tests__/internal-relay-events.test.ts
  pnpm --filter @generacy-ai/orchestrator test src/__tests__/vscode-tunnel-retained-replay.integration.test.ts
  pnpm --filter @generacy-ai/control-plane test __tests__/vscode-tunnel-manager.test.ts
  ```
  All green. Then `pnpm --filter @generacy-ai/orchestrator build && pnpm --filter @generacy-ai/control-plane build` to catch TS errors. Manual SC-001 repro (10 fresh clusters) is captured in `quickstart.md` §"Manual repro" — not automated in this task, but the CI + unit + integration coverage above satisfies SC-002/SC-003/SC-004/SC-005.

## Dependencies & Execution Order

**Sequential chain (blocks downstream)**:
- T001 (changeset) → any code change. CI gate requires the changeset to land in the same PR.
- T002 (`retained-tunnel-event.ts` module) → T004, T005, T006, T007, T013 (all import from it).
- T004 (route write path) → T005 (route tests exercise the mutation) and T013 (integration exercises the full write→read cycle).
- T006 (`relay-bridge.ts` read path) → T007 (unit) and T013 (integration).
- T008 (add `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS`, `authTimer`, `armAuthTimer`, `clearAuthTimer`) → T009 (arm site) → T010 (clear sites) → T011 (fresh-emit branch) → T012 (tests). All touch `vscode-tunnel-manager.ts`; keep sequential to avoid merge conflicts inside one file.

**Parallel opportunities (`[P]`)**:
- T003 (unit test for `retained-tunnel-event.ts`) can run in parallel with T004 (route wiring) once T002 exists — different files, no runtime dependency between them.

**Cross-phase independence**:
- Phase 2/3 (orchestrator) and Phase 4 (control-plane) touch disjoint packages and can be developed in parallel branches if desired. They only meet in the Phase 5 integration test (T013), which stubs the control-plane HTTP call anyway.

**Verification comes last**: T014 depends on all prior tasks.

## Success-Criteria Coverage

| SC     | Task(s)                     |
|--------|-----------------------------|
| SC-001 | T014 (manual per quickstart)|
| SC-002 | T013                        |
| SC-003 | T012 (FR-004 positive/negative) |
| SC-004 | T012 (FR-003 fresh-emit)    |
| SC-005 | T003 (eligibility filter)   |
