# Tasks: Restart-tunnel button silently no-ops after device-code timeout

**Input**: Design documents from `/specs/825-summary-cloud-restart-tunnel/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/vscode-tunnel-manager.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 is the sole story for this bugfix)

## Phase 1: Setup

- [ ] T001 Verify baseline: run `pnpm --filter @generacy-ai/control-plane test -- vscode-tunnel-manager` on the current branch to confirm the existing test suite passes before edits begin. Establishes the pre-change green baseline referenced by SC-001/SC-002/SC-003 validation.

## Phase 2: Tests First (extend regression suite)

Write failing tests that pin the post-fix contract before touching production code. All test additions land in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts`.

- [ ] T002 [US1] Extend `describe("device code timeout")` in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` with an assertion that after `vi.advanceTimersByTime(deviceCodeTimeoutMs)`, the mock child receives `child.kill` with `"SIGTERM"` (FR-001).
- [ ] T003 [US1] Extend `describe("device code timeout")` in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` with an assertion that after the timeout, exactly ONE `error` event was emitted on the relay stream, with `error === "Timed out waiting for device code"` and `tunnelName` populated; assert the `"code tunnel exited (code N)…"` text is NOT present (FR-005, SC-002, Q3→A).
- [ ] T004 [US1] Extend `describe("device code timeout")` in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` with an assertion that after `child.emit("exit", …)` following the timeout, no second `error` event is emitted (FR-002, SC-002).
- [ ] T005 [US1] Extend `describe("device code timeout")` in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` with an assertion that after the timeout + exit sequence settles, `mgr.getStatus() === "error"` (FR-004).
- [ ] T006 [US1] Extend `describe("device code timeout")` in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` with an assertion that a second `mgr.start()` call after a settled timeout causes `spawnMock` to be invoked a second time (SC-001) — the Restart-button recovery case.
- [ ] T007 [US1] Extend `describe("start() idempotency")` in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` with a stale-child recovery test: manually set `(mgr as any).child = staleChild` and `(mgr as any).status = "error"`, call `await mgr.start()`, assert `staleChild.kill` was called with `"SIGTERM"` AND that `spawnMock.mock.invocationCallOrder[0] > staleChild.kill.mock.invocationCallOrder[0]` — no concurrent overlap (FR-003, SC-003).
- [ ] T008 [US1] Extend `describe("start() idempotency")` in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` with parallel stale-child recovery tests for `status === "disconnected"` and `status === "stopped"` variants (FR-003 recovery states).
- [ ] T009 [US1] Extend `describe("start() idempotency")` in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` with a regression guard: normal `start()` → `connected` → `stop()` → `start()` reconnect still spawns cleanly with only one `spawn` per `start()` (Case 5 in `quickstart.md`; ensures FR-003 branch does not fire when `this.child === null`).
- [ ] T010 [US1] Run `pnpm --filter @generacy-ai/control-plane test -- vscode-tunnel-manager` and confirm T002–T009 all fail with the current implementation. This locks in the red-baseline before Phase 3.

## Phase 3: Core Implementation (production edits)

Three coordinated edits in `packages/control-plane/src/services/vscode-tunnel-manager.ts`. All Phase 3 tasks touch the same file; they are strictly sequential — no `[P]` marker.

- [ ] T011 [US1] Add the new private field `private timedOut = false;` to the `VsCodeTunnelProcessManager` class (near existing `stopping = false;` at ~line 108) in `packages/control-plane/src/services/vscode-tunnel-manager.ts` (data-model.md §"Private state").
- [ ] T012 [US1] Modify the device-code timeout handler (currently ~lines 235-247) in `packages/control-plane/src/services/vscode-tunnel-manager.ts`: after setting `this.status = "error"` and emitting the single `error` event (add `tunnelName: this.opts.tunnelName` to the payload for parity with other error events), set `this.timedOut = true`, call `this.child?.kill("SIGTERM")`, then schedule `setTimeout(() => this.child?.kill("SIGKILL"), this.opts.forceKillTimeoutMs ?? DEFAULT_FORCE_KILL_TIMEOUT_MS)` as the SIGKILL backstop (FR-001).
- [ ] T013 [US1] Modify the child-`exit` handler (currently ~lines 164-201) in `packages/control-plane/src/services/vscode-tunnel-manager.ts`: read `const timedOut = this.timedOut;` at the top of the handler alongside the existing `const stopInitiated = this.stopping;`, clear `this.timedOut = false;` in the same block that clears `this.stopping = false;`, and insert a new `else if (timedOut) { /* keep status = "error"; suppress emit */ }` branch **immediately after** the `stopInitiated` branch and **before** the `wasConnected`/`wasPending` branches (FR-002, data-model.md branching table).
- [ ] T014 [US1] Modify the `start()` early-return guard (currently ~lines 126-146) in `packages/control-plane/src/services/vscode-tunnel-manager.ts`: split the existing `if (this.child) { … }` block into two branches — first a new `if (this.status === "error" || this.status === "disconnected" || this.status === "stopped") { await this.stop(); /* fall through to spawn */ }` recovery branch, then the existing "already running" re-emit branch (for `authorization_pending` / `connected`) that returns early. Ensure the fresh-spawn path below is reached after the `await stop()` (FR-003, defense-in-depth).

## Phase 4: Verify tests pass

- [ ] T015 [US1] Run `pnpm --filter @generacy-ai/control-plane test -- vscode-tunnel-manager` and confirm all tests (existing + T002–T009) now pass. Every task listed in Phase 2 must go green.
- [ ] T016 [US1] Run `pnpm --filter @generacy-ai/control-plane test` to confirm no other control-plane suites regressed (in particular `lifecycle-vscode-tunnel.test.ts`, which exercises the route → manager wiring).

## Phase 5: Polish & Static Validation

- [ ] T017 [US1] Run `pnpm --filter @generacy-ai/control-plane typecheck` (or `tsc --noEmit`) and confirm no new TypeScript errors from the `timedOut` field or the `start()` branch restructuring.
- [ ] T018 [US1] Run `pnpm --filter @generacy-ai/control-plane lint` (if configured) or the repo-wide `pnpm lint` and confirm the edited file passes lint.
- [ ] T019 [US1] Execute the three grep-based Success Criteria checks from `specs/825-summary-cloud-restart-tunnel/quickstart.md` §"Success criteria checks":
  - SC-001: `grep -A 15 "deviceCodeTimer = setTimeout" packages/control-plane/src/services/vscode-tunnel-manager.ts | grep -E "kill|timedOut = true"` — expect the SIGTERM kill and `timedOut = true` marker.
  - SC-002: `grep -B 2 -A 8 "timedOut" packages/control-plane/src/services/vscode-tunnel-manager.ts` — expect the `else if (timedOut)` branch above `else if (wasPending)`.
  - SC-003: `grep -B 2 -A 10 "async start()" packages/control-plane/src/services/vscode-tunnel-manager.ts | grep -E "await this.stop\(\)|status === \"error\"|status === \"disconnected\"|status === \"stopped\""` — expect the recovery guard.
- [ ] T020 [US1] Optional manual E2E: build the control-plane, boot a local cluster against a cloud instance, force a device-code timeout, click the Restart tunnel button, and confirm a fresh `code tunnel` child spawns (quickstart.md §"End-to-end validation"). Skip if unit-test suite plus SC checks are sufficient for reviewer sign-off.

## Dependencies & Execution Order

**Strictly sequential blocks (no parallelism)**:
- Phase 1 (T001) → Phase 2 → Phase 3 → Phase 4 → Phase 5.
- Within Phase 3, T011 → T012 → T013 → T014 all edit the same file, so they must be applied sequentially.

**Parallelizable within Phase 2** (test additions):
- T002, T003, T004, T005, T006 all extend `describe("device code timeout")` — same file, but conceptually independent assertions. Because they all mutate one test file, apply them sequentially in practice but they can be authored in any order.
- T007 and T008 both extend `describe("start() idempotency")` — same file; author sequentially.
- T009 is a stand-alone regression test in `describe("start() idempotency")`.
- No `[P]` markers used because every task in this feature edits one of two files (production or test), and same-file edits do not benefit from parallel execution.

**Critical path (bugfix logic order)**:
1. T010 (tests fail) — proves the current-behavior gap.
2. T011 (new field) — precondition for T012 and T013.
3. T012 (timeout handler kills child, sets `timedOut`) — makes T004/T005/T006 go green.
4. T013 (exit handler suppresses second emit) — makes T003 go green.
5. T014 (start() recovery guard) — makes T007/T008 go green.
6. T015/T016 — full green re-verification.
7. T017–T020 — belt-and-suspenders static + optional manual validation.

**Note on scope**: FR-006 (cloud-side stop-then-start on Restart click) is explicitly out of scope for this repo and this task list — see `spec.md` §"Out of Scope" and `plan.md` §"OUT OF SCOPE" block. It will be filed as a companion issue against `generacy-cloud/packages/web/src/lib/hooks/use-vscode-tunnel.ts`.
