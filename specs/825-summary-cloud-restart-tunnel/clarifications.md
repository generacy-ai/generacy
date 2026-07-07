# Clarifications

## Batch 1 — 2026-07-07

### Q1: Duplicate error event suppression mechanism
**Context**: FR-005 requires "exactly one `error` event on `cluster.vscode-tunnel`" when the device-code timeout fires. Today the timeout handler emits one error, and if the fix adds `child.kill()` in that handler, the child's `exit` listener (`vscode-tunnel-manager.ts:164-201`) will fire the `wasPending` branch and emit a second error ("code tunnel exited (code N) before reaching connected state"). The spec locks the outcome (one event) but not the mechanism.

**Question**: Which mechanism should the fix use to prevent the child-exit path from emitting a second `error` event when the timeout initiates the kill?

**Options**:
- A: Reuse the existing `stopping = true` flag before calling `child.kill()` in the timeout handler. The exit handler already treats `stopInitiated` as a normal stop (no error emit). Simplest; also implies the final status becomes `stopped` (see Q2).
- B: Add a new `timedOut = true` flag. The exit handler checks it and skips the error emit, leaving `status = "error"` as set by the timeout handler.
- C: Something else (please describe).

**Answer**: B — add a dedicated `timedOut` flag; don't reuse `stopping`. The timeout handler sets `status = "error"`, emits the single error event, sets `timedOut = true`, then kills the child. The `exit` listener checks `timedOut`, skips its `wasPending` error emit, and leaves `status = "error"` intact. Reusing `stopping` (option A) routes the exit through the `stopInitiated` branch and forces the resting status to `"stopped"` (Q2) — conflating a genuine failure with a user-initiated stop, and discarding the meaningful timeout message (Q3). A distinct flag keeps the two exit reasons — user stop vs. self-kill-after-timeout — semantically separate.

---

### Q2: Final `status` after timeout + kill completes
**Context**: Once the fix kills the child on device-code timeout and the child's `exit` handler runs, the manager needs a resting status. FR-003 lists both `error` and `stopped` as valid "must respawn from" states for the next `start()`, so either satisfies the recovery contract. But the UI/telemetry semantics differ: `error` keeps the failure visible in `getStatus()`/`/health` until the user retries; `stopped` presents a clean slate.

**Question**: After the device-code timeout completes (timeout handler + child-exit cleanup both run), what should `manager.getStatus()` return?

**Options**:
- A: `"error"` — user-visible failure state persists until next `start()`. Consistent with the emitted `error` event and today's spec language ("lands in `status = "error"`").
- B: `"stopped"` — reset to a clean idle state after cleanup. Natural fit if Q1=A (the `stopping` flag path sets `stopped`).
- C: `"error"` first, then transition to `"stopped"` after the child exits.

**Answer**: A — resting status `"error"`. A device-code timeout is a real failure (the CLI never surfaced a code within the window — an auth/network problem), and the user should see it, not a clean slate. It matches the emitted error event and the spec's "lands in `status = "error"`" language. Recovery is unaffected: FR-003 already lists `error` among the respawn-from states, so the next `start()` (Restart) respawns regardless. `"stopped"` (B) would hide an actionable failure behind an idle-looking state.

---

### Q3: Error message text priority when timeout fires
**Context**: FR-005 requires exactly one error event but does not specify its `error` field text. The two candidate strings are: (a) `"Timed out waiting for device code"` from the timer (proximal cause the user should see), and (b) `"code tunnel exited (code N) before reaching connected state"` from the child-exit handler (mechanical consequence). Whichever mechanism from Q1 is chosen determines which one propagates.

**Question**: Which error message should appear in the single emitted `error` event after a device-code timeout?

**Options**:
- A: `"Timed out waiting for device code"` — user-facing, describes the actual failure. Requires the timeout handler to fire the event and the exit handler to be suppressed.
- B: `"code tunnel exited (code N) before reaching connected state"` — describes the process outcome. Only makes sense if the timeout handler kills silently and defers the emit to `exit`.
- C: A merged message (e.g., timeout text with exit code in `details`).

**Answer**: A — `"Timed out waiting for device code"`. That's the proximal, actionable cause. `"code tunnel exited (code N)…"` describes a process exit that *we* initiated by killing it — mechanically true but misleading as the user-facing reason. Keep the last stdout lines in `details` as the timeout handler already does. This follows directly from Q1=B: the timeout handler owns the emit, the exit handler is suppressed.

---

### Q4: `start()` recovery semantics when a stale `this.child` exists (FR-003)
**Context**: FR-003 says `start()` MUST "stop-then-spawn" if it finds a live `this.child` while `status ∈ {error, disconnected, stopped}` (defense-in-depth for any path that fails to clear `child`). The existing `stop()` awaits child exit with a `forceKillTimeoutMs = 5_000` SIGTERM→SIGKILL window. The spec doesn't say whether `start()` should await that window before spawning.

**Question**: When `start()` needs to stop a stale child before spawning a fresh one, should it `await stop()` (blocking up to `forceKillTimeoutMs`) before `spawn()`, or should it fire the kill and spawn immediately?

**Options**:
- A: `await stop()` before `spawn()` — clean sequencing, no process overlap, but the caller (`POST /lifecycle/vscode-tunnel-start`) may wait up to 5s. Cloud UI already treats the Restart as an async operation.
- B: Fire-and-forget `stop()` (or synchronous `child.kill("SIGTERM")`) and `spawn()` immediately — faster UI response, but brief overlap of two `code tunnel` processes until the stale one exits, risking a tunnel-name registration race.
- C: Something else (please describe).

**Answer**: A — `await stop()` before `spawn()`. Never allow two `code tunnel --name <same>` processes to overlap. A concurrent second registration of the same name is exactly the collision that made the CLI fall back to a random name and the cloud deep-link to a dead tunnel in #743. `await stop()` (≤ `forceKillTimeoutMs` = 5s, SIGTERM→SIGKILL) guarantees the stale process is gone before the new one registers. The Restart path is already async in the cloud UI, so the worst-case 5s wait is acceptable; correctness beats shaving latency here. Bonus: `stop()` sets `stopping = true`, so the stale child's exit routes to `"stopped"` with no spurious error event during recovery.

---

## Net resting contract after a device-code timeout

- **One** `error` event on `cluster.vscode-tunnel`, message `"Timed out waiting for device code"`
- `manager.getStatus() === "error"`
- `this.child === null`
- The next `start()` (Restart) spawns cleanly with no early-return.

---
