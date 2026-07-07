# Research: Restart-tunnel silently no-ops after device-code timeout

**Feature**: `825-summary-cloud-restart-tunnel` | **Date**: 2026-07-07

Four discrete design decisions. Each one is anchored in a clarification and in the observable contract on `cluster.vscode-tunnel` that the cloud UI already consumes.

## Decision 1 — Mechanism for suppressing the duplicate `exit`-branch error

**Decision**: Add a dedicated `private timedOut = false` field on `VsCodeTunnelProcessManager`. The device-code timeout handler sets `this.timedOut = true` immediately before calling `child.kill("SIGTERM")`. The child-`exit` handler reads the flag at the top of its body (mirroring how it already reads `this.stopping`), clears it, and — if set — skips the `wasPending` `error` emit and leaves `status = "error"` intact while still nulling out `this.child` and running the exit waiters. Do **not** reuse the existing `stopping` flag.

**Rationale**:
- Two distinct exit reasons (user-initiated `stop()` vs. self-initiated kill-after-timeout) deserve two distinct flags. Conflating them via `stopping` would route the exit through the `stopInitiated` branch that forces `status = "stopped"` — a clean-slate state that hides an actionable failure (see Decision 2) and discards the meaningful timeout error text (see Decision 3).
- The mechanism is a one-field, one-branch add. The `exit` handler already has the shape it needs — an early `stopInitiated`-vs-`wasConnected`-vs-`wasPending` cascade. `timedOut` becomes a new branch above `wasPending` (see data-model.md §"Exit handler branching table" for the exact ordering).
- Symmetry with `this.stopping`: same lifecycle (set before kill, cleared at exit-handler entry), same self-contained scope.

**Alternatives considered**:
- **Reuse the `stopping = true` flag** (Q1→A). Rejected: `stopInitiated` forces `status = "stopped"`, conflicting with Q2→A ("resting status stays `"error"`") and Q3→A ("keep the timeout message"). Cascades wrong.
- **No flag; suppress the exit emit by inspecting `status === "error"`** (informal Q1→C variant). Rejected: `status` is not a reliable disambiguator — the spawn-`error` handler also sets `status = "error"` and its `exit` follow-up would also be suppressed incorrectly. A dedicated flag is more precise and easier to read.

**References**: clarification Q1 → B; `packages/control-plane/src/services/vscode-tunnel-manager.ts:164-201` (existing exit handler cascade), `:112` (existing `stopping` field).

---

## Decision 2 — Resting `status` after the timeout + kill cascade

**Decision**: `manager.getStatus() === "error"` after both the timeout handler and the child-exit handler have run. Do not transition to `"stopped"` (or through `"stopped"` on the way to `"error"`).

**Rationale**:
- A device-code timeout is a real failure — the CLI never surfaced a code within the 30s window, which almost always means an auth issue or a network problem the user should act on.
- `"error"` matches the emitted `error` event (Decision 3) and the spec's "lands in `status = "error"`" language.
- Recovery is unaffected: FR-003 already lists `"error"` among the respawn-from states, so the next `start()` (Restart) spawns cleanly regardless (see Decision 4).
- `"stopped"` (Q2→B) would present an idle-looking manager after a failure — hiding actionable state behind a clean slate. Bad UX for anyone reading `getStatus()` or `/health` between clicks.
- The A + then-B transition (Q2→C) buys nothing at the cost of one extra intermediate status, and the emitted event stream would need to grow to reflect the transient state accurately — not worth it.

**Alternatives considered**:
- **Reset to `"stopped"`** (Q2→B). Rejected — see above.
- **`"error"` first, then transition to `"stopped"` after exit** (Q2→C). Rejected — no observable benefit, extra state churn.

**References**: clarification Q2 → A; spec §Root cause ("manager is left with `status = "error"`"), §"Net resting contract".

---

## Decision 3 — Text of the single `error` event

**Decision**: The single emitted `error` event carries `error: "Timed out waiting for device code"` and `details: <last 20 stdout lines>`. The child-exit handler's `"code tunnel exited (code N) before reaching connected state"` text is suppressed on the timeout path.

**Rationale**:
- The timeout message names the proximal, actionable cause. The user sees why the tunnel didn't come up.
- The "code tunnel exited" text describes a process exit that the manager itself initiated by killing the child — mechanically true but misleading as a user-facing reason. If a user sees "code tunnel exited (code N)" without context, they will look for a CLI-side crash. The real failure is upstream (device-code endpoint never returned).
- Last-20-stdout-lines in `details` preserves diagnostic information for anyone digging deeper — the exit code and any last stderr writes are already reachable via cluster logs if needed.
- This follows directly from Decision 1 (Q1→B): the timeout handler owns the emit; the exit handler is suppressed.

**Alternatives considered**:
- **Emit the exit-handler text instead** (Q3→B). Rejected — see above; misleading proximal cause.
- **Merged message with exit code in `details`** (Q3→C). Rejected — extra structure with no consumer. The exit code is not user-actionable when the manager killed the child.

**References**: clarification Q3 → A; `vscode-tunnel-manager.ts:235-247` (timeout handler emits this text today), `:185-193` (exit handler's `wasPending` branch — the one to suppress).

---

## Decision 4 — `start()` recovery semantics when a stale `this.child` exists

**Decision**: `start()` explicitly checks whether `this.child` exists but `status ∈ { "error", "disconnected", "stopped" }`. If so, `await stop()` (which handles SIGTERM → SIGKILL over `forceKillTimeoutMs = 5000`) before falling through to the fresh-spawn path. **Never** spawn while a `code tunnel --name <same>` process is still running.

**Rationale**:
- Concurrent second registrations of the same tunnel name are exactly the collision that #743 diagnosed: the CLI silently falls back to a random name and the cloud deep-link hits a dead tunnel. `await stop()` guarantees the stale process is gone before the new one registers.
- `stop()` already sets `stopping = true` before killing; the stale child's exit routes to the `"stopped"` branch (no spurious `error` event during recovery). Zero collateral events.
- The Restart path is already async in the cloud UI (spec §Assumptions), so the worst-case 5s wait is acceptable. Correctness beats shaving latency here.
- This is defense-in-depth: with Decisions 1/2/3 in place, the timeout path already ends with `this.child === null`, so this branch only matters if some *other* future code path fails to clear `child`. FR-003 makes the manager self-recovering from any such regression.

**Alternatives considered**:
- **Fire-and-forget `stop()`** (or synchronous `child.kill("SIGTERM")`) followed by immediate `spawn()` (Q4→B). Rejected — brief but real overlap of two `code tunnel` processes; risks a tunnel-name registration race exactly like #743.
- **Do nothing in `start()`; rely purely on Decisions 1/2/3** (informal option). Rejected — no self-recovery from any future regression that leaves `child` set with a resting-error status.

**References**: clarification Q4 → A; `#743` (tunnel-name collision precedent); `vscode-tunnel-manager.ts:126-146` (current early-return path — the one to harden), `:252-272` (existing `stop()` implementation — already handles SIGTERM → SIGKILL).

---

## Implementation patterns to follow

- **Existing exit-handler cascade**: `if (stopInitiated) … else if (wasConnected) … else if (wasPending) … else …`. Add `timedOut` above `wasPending` as a peer branch. Same pattern — read the flag once at the top of the handler, clear it, then use it in the cascade.
- **Kill sequencing**: the existing `stop()` already models the SIGTERM → `forceKillTimeoutMs` → SIGKILL pattern (`:258-270`). Reuse that same pattern in the timeout handler — do not invent a new kill helper.
- **Emitting events**: continue to use `emitTunnelEvent({ status: "error", error, details, tunnelName })`. The `tunnelName` field on the timeout error is currently absent; add it for consistency with all other error emits (no test breakage — existing tests only assert `status`/`error`/`details`, see `vscode-tunnel-manager.test.ts:233-267`).
- **Test extension pattern**: `vscode-tunnel-manager.test.ts` already uses fake timers for the timeout tests and `EventEmitter`-based fake children. Extend that same setup — add tests that verify: (a) the child gets `SIGTERM` after the timeout fires; (b) `child.emit("exit")` after the timeout does NOT emit a second `error`; (c) `getStatus()` remains `"error"` after the exit; (d) a subsequent `start()` spawns fresh (`spawnMock.mock.calls.length === 2`).

## Key references

- `packages/control-plane/src/services/vscode-tunnel-manager.ts` — the file being fixed.
- `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` — the test file to extend.
- `#604` (device-code emit-before-subscribe race) — touched this same `start()` early-return path; the current fix hardens it further.
- `#743` (tunnel-name collision from concurrent registrations) — the precedent that motivates Q4→A `await stop()`.
- Companion issue (out-of-scope in this PR): auto-restart after cluster stop/start — that is the *primary* reason users reach for Restart in the first place. Tracked in `#824` per spec.
