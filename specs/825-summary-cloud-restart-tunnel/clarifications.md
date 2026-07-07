# Clarifications

## Batch 1 — 2026-07-07

### Q1: Duplicate error event suppression mechanism
**Context**: FR-005 requires "exactly one `error` event on `cluster.vscode-tunnel`" when the device-code timeout fires. Today the timeout handler emits one error, and if the fix adds `child.kill()` in that handler, the child's `exit` listener (`vscode-tunnel-manager.ts:164-201`) will fire the `wasPending` branch and emit a second error ("code tunnel exited (code N) before reaching connected state"). The spec locks the outcome (one event) but not the mechanism.

**Question**: Which mechanism should the fix use to prevent the child-exit path from emitting a second `error` event when the timeout initiates the kill?

**Options**:
- A: Reuse the existing `stopping = true` flag before calling `child.kill()` in the timeout handler. The exit handler already treats `stopInitiated` as a normal stop (no error emit). Simplest; also implies the final status becomes `stopped` (see Q2).
- B: Add a new `timedOut = true` flag. The exit handler checks it and skips the error emit, leaving `status = "error"` as set by the timeout handler.
- C: Something else (please describe).

**Answer**: *Pending*

---

### Q2: Final `status` after timeout + kill completes
**Context**: Once the fix kills the child on device-code timeout and the child's `exit` handler runs, the manager needs a resting status. FR-003 lists both `error` and `stopped` as valid "must respawn from" states for the next `start()`, so either satisfies the recovery contract. But the UI/telemetry semantics differ: `error` keeps the failure visible in `getStatus()`/`/health` until the user retries; `stopped` presents a clean slate.

**Question**: After the device-code timeout completes (timeout handler + child-exit cleanup both run), what should `manager.getStatus()` return?

**Options**:
- A: `"error"` — user-visible failure state persists until next `start()`. Consistent with the emitted `error` event and today's spec language ("lands in `status = "error"`").
- B: `"stopped"` — reset to a clean idle state after cleanup. Natural fit if Q1=A (the `stopping` flag path sets `stopped`).
- C: `"error"` first, then transition to `"stopped"` after the child exits.

**Answer**: *Pending*

---

### Q3: Error message text priority when timeout fires
**Context**: FR-005 requires exactly one error event but does not specify its `error` field text. The two candidate strings are: (a) `"Timed out waiting for device code"` from the timer (proximal cause the user should see), and (b) `"code tunnel exited (code N) before reaching connected state"` from the child-exit handler (mechanical consequence). Whichever mechanism from Q1 is chosen determines which one propagates.

**Question**: Which error message should appear in the single emitted `error` event after a device-code timeout?

**Options**:
- A: `"Timed out waiting for device code"` — user-facing, describes the actual failure. Requires the timeout handler to fire the event and the exit handler to be suppressed.
- B: `"code tunnel exited (code N) before reaching connected state"` — describes the process outcome. Only makes sense if the timeout handler kills silently and defers the emit to `exit`.
- C: A merged message (e.g., timeout text with exit code in `details`).

**Answer**: *Pending*

---

### Q4: `start()` recovery semantics when a stale `this.child` exists (FR-003)
**Context**: FR-003 says `start()` MUST "stop-then-spawn" if it finds a live `this.child` while `status ∈ {error, disconnected, stopped}` (defense-in-depth for any path that fails to clear `child`). The existing `stop()` awaits child exit with a `forceKillTimeoutMs = 5_000` SIGTERM→SIGKILL window. The spec doesn't say whether `start()` should await that window before spawning.

**Question**: When `start()` needs to stop a stale child before spawning a fresh one, should it `await stop()` (blocking up to `forceKillTimeoutMs`) before `spawn()`, or should it fire the kill and spawn immediately?

**Options**:
- A: `await stop()` before `spawn()` — clean sequencing, no process overlap, but the caller (`POST /lifecycle/vscode-tunnel-start`) may wait up to 5s. Cloud UI already treats the Restart as an async operation.
- B: Fire-and-forget `stop()` (or synchronous `child.kill("SIGTERM")`) and `spawn()` immediately — faster UI response, but brief overlap of two `code tunnel` processes until the stale one exits, risking a tunnel-name registration race.
- C: Something else (please describe).

**Answer**: *Pending*

---
