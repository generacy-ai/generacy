# Implementation Plan: Restart-tunnel button silently no-ops after device-code timeout

**Feature**: Fix `VsCodeTunnelProcessManager` so the cloud **Restart tunnel** button reliably respawns the `code tunnel` child after a prior start attempt hit the 30s device-code timeout. Today the timeout leaves `status = "error"` alongside a live `this.child`, and every subsequent `start()` (the Restart button) hits the early-return and does nothing.
**Branch**: `825-summary-cloud-restart-tunnel`
**Status**: Complete
**Date**: 2026-07-07
**Spec**: [spec.md](./spec.md)
**Input**: Feature specification at `/specs/825-summary-cloud-restart-tunnel/spec.md`

## Summary

Single-file surgery in `packages/control-plane/src/services/vscode-tunnel-manager.ts` (three coordinated edits, one new private field, and a hardened `start()` guard):

1. **Device-code timeout handler** (currently lines 235-247): after setting `status = "error"` and emitting the single error event, set the new `timedOut = true` flag, then `child.kill("SIGTERM")` with a `forceKillTimeoutMs = 5000` SIGKILL backstop. The exit handler will clear `this.child`.
2. **Child-`exit` handler** (currently lines 164-201): read and clear `timedOut` at the top (like the existing `stopping` clear). If `timedOut`, skip the `wasPending` error emit and leave `status = "error"` intact — but still null out `this.child` and run the exitWaiters. Result: exactly one `error` event per timeout with message `"Timed out waiting for device code"`.
3. **`start()` early-return guard** (currently lines 126-146): before the existing "already running" re-emit logic, check whether `this.child` exists but `status ∈ { "error", "disconnected", "stopped" }`. If so, `await stop()` (which handles SIGTERM → SIGKILL sequencing) and fall through to the fresh-spawn path. This is defense-in-depth: with fix (1)/(2) in place the timeout path already ends with `this.child === null`, so this only matters if some *other* code path fails to clear `child`.

Net contract after a device-code timeout (from clarifications.md §"Net resting contract"):
- **One** `error` event on `cluster.vscode-tunnel`, message `"Timed out waiting for device code"`, with the timer's last-20-stdout-lines in `details`.
- `manager.getStatus() === "error"`.
- `this.child === null`.
- The next `start()` (Restart) spawns cleanly with no early-return.

The optional cloud-side stop-then-start companion (FR-006) is filed separately and deferred. This plan is sufficient on its own for SC-001/SC-002/SC-003.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >=22 (`node:child_process`, `ChildProcess`, `setTimeout`).
**Primary Dependencies**: None new. `@generacy-ai/control-plane` internal only — `getRelayPushEvent()` from `../relay-events.js` for the single `error` event emit, `spawn` from `node:child_process` for the existing child.
**Storage**: None. Manager owns process-lifetime in-memory state (`child`, `status`, `deviceCodeTimer`, `stopping`, new `timedOut`). No persistence across control-plane restarts (spec §Out of Scope).
**Testing**: `vitest` in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` (existing file, ~940 LOC of coverage). Fake timers already used for the timeout tests; extend the same pattern.
**Target Platform**: Any environment where the control-plane process runs — dev laptop devcontainer, cluster orchestrator container in prod.
**Project Type**: Single-package edit inside a monorepo. One production file modified; one test file extended.
**Performance Goals**:
- No perf-relevant paths. The timeout handler grows by one `child.kill()` call and one SIGKILL backstop timer (≤5s). The `start()` early-return path grows by an `await stop()` in the defense-in-depth branch (≤5s worst case, only fires on a stale-child recovery).
- Restart click still returns fast when there is no stale child (unchanged path). Worst case: user clicks Restart with a stale child that ignores SIGTERM — 5s SIGKILL + immediate spawn.
**Constraints**:
- **No process overlap.** Two concurrent `code tunnel --name <same>` processes must never exist (clarification Q4→A, #743 precedent). `await stop()` in the stale-child recovery guarantees this.
- **One error event per failed attempt.** The dedicated `timedOut` flag (clarification Q1→B) ensures the exit handler's `wasPending` branch is suppressed after a timeout-initiated kill. Reusing `stopping` (Q1→A) was rejected because it would conflate a genuine failure with a user-initiated stop, force `status = "stopped"` (Q2→A rejects this), and discard the actionable timeout message (Q3→A rejects this).
- **Resting status is `"error"`, not `"stopped"`.** A device-code timeout is a real failure — an auth/network problem the user should see. `"stopped"` would hide it behind an idle-looking state (Q2→A).
- **Error message is `"Timed out waiting for device code"`.** The proximal cause. `"code tunnel exited (code N)…"` describes a process exit that the manager *itself* initiated by killing the child — mechanically true but misleading (Q3→A).
- **`forceKillTimeoutMs = 5000` and `deviceCodeTimeoutMs = 30_000` constants are unchanged** (spec §Out of Scope).
**Scale/Scope**: 1 production file edited (~40 net LOC), 1 test file extended (~150 net LOC of new tests covering FR-001..FR-005 and SC-001..SC-003).

## Constitution Check

No `.specify/memory/constitution.md` present in this repo (only `.specify/templates/`). No gates to evaluate. Constitution check **PASS** (vacuously).

## Project Structure

### Documentation (this feature)

```text
specs/825-summary-cloud-restart-tunnel/
├── spec.md                                          # already authored
├── clarifications.md                                # already authored (Batch 1, Q1–Q4)
├── plan.md                                          # THIS FILE
├── research.md                                      # decision rationale (mechanism, resting status, error text, stale-child recovery)
├── data-model.md                                    # interface + private-state deltas, exit-handler branching table
├── quickstart.md                                    # local repro + validation of SC-001/SC-002/SC-003
└── contracts/
    └── vscode-tunnel-manager.md                     # public contract of VsCodeTunnelManager after the fix — status semantics, event stream, start()/stop() re-entry rules
```

`tasks.md` is produced by `/speckit:tasks`, not this command.

### Source Code (generacy monorepo)

```text
packages/control-plane/
├── src/services/
│   └── vscode-tunnel-manager.ts                     # MODIFIED — three coordinated edits (see Summary): device-code timeout kills the child; child-exit handler branches on new `timedOut` flag; start() guard respawns from resting-error states. Adds one new private field: `private timedOut = false`.
└── __tests__/
    └── vscode-tunnel-manager.test.ts                # MODIFIED — extend the existing "device code timeout" describe block for FR-001/FR-002/FR-005 (one error event with the right text; final status is "error"; child cleared; second start() spawns); extend "start() idempotency" for FR-003/FR-004 (respawn from error / disconnected / stopped when child stale). ~150 net LOC.

# UNTOUCHED (in this repo)
packages/control-plane/src/routes/lifecycle.ts       # `vscode-tunnel-start` route already delegates to `manager.start()` — the fix lands inside the manager. No route changes.
packages/control-plane/src/relay-events.ts           # emitTunnelEvent → getRelayPushEvent pathway unchanged. Same single-event-per-emit semantics.

# OUT OF SCOPE (companion — filed separately)
# generacy-cloud/packages/web/src/lib/hooks/use-vscode-tunnel.ts   # FR-006 optional stop-then-start on Restart click. Deferred; the fix works without it.
```

**Structure Decision**: Single-file production edit inside `packages/control-plane`. The fix is intentionally narrow — the bug is a two-line lifecycle oversight in one class, and the correct scope is exactly that class plus its test suite. No new files, no cross-package changes, no cross-repo changes. Companion cloud-side FR-006 is deferrable per spec (§Out of Scope reads "Optional; the fix in `packages/control-plane` is sufficient on its own").

**Why the fix stays inside `VsCodeTunnelProcessManager`**: the process-lifecycle invariants live there — "one child at a time", "status transitions are the source of truth", "the exit handler owns cleanup". Fixing the bug outside the class (e.g. by making `lifecycle.ts` call `stop()` before `start()` on every request) would leak lifecycle knowledge into the route layer and fail to fix the *initial-boot* case that reaches `start()` via `bootstrap-complete` in `lifecycle.ts` — same code path, same bug, same fix location.

**Why the `start()` early-return hardening is included even though (1)/(2) alone close the timeout gap**: defense in depth. The bug is subtle precisely because it took a specific state (`this.child` set, `status = "error"`) and every future contributor who touches the exit / kill / error paths risks re-introducing it. FR-003 makes `start()` self-recovering from any resting-error state, so a future bug in the timeout path — or any other code path that fails to clear `child` — cannot re-create the "Restart does nothing" observable. This is what clarification Q4 → A locked in.

**Why `await stop()` and not fire-and-forget (Q4→A)**: never allow two `code tunnel --name <same>` processes to overlap. #743 is the precedent — concurrent second registrations of the same name caused the CLI to fall back to a random name and the cloud deep-link to hit a dead tunnel. `await stop()` (≤5s, SIGTERM → SIGKILL) guarantees the stale process is gone before the new one registers. The Restart path is already async in the cloud UI, so the worst-case 5s wait is acceptable — correctness beats shaving latency here. Bonus: `stop()` sets `stopping = true`, so the stale child's exit routes to the clean `"stopped"` branch with no spurious error event during recovery.

## Complexity Tracking

> No constitution violations. Table retained for template compliance.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _none_   | _n/a_      | _n/a_                                |
