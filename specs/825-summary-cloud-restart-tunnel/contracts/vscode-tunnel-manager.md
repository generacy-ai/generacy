# Contract: VsCodeTunnelManager (post-fix)

**Feature**: `825-summary-cloud-restart-tunnel` | **Date**: 2026-07-07

Documents the public contract of `VsCodeTunnelManager` after this fix lands. Consumed by `packages/control-plane/src/routes/lifecycle.ts` (`vscode-tunnel-start` / `vscode-tunnel-stop`) and, transitively, by the cloud UI's `use-vscode-tunnel.ts` hook via the `cluster.vscode-tunnel` relay channel.

## Public interface (unchanged)

```ts
export type VsCodeTunnelStatus =
  | "stopped"
  | "starting"
  | "authorization_pending"
  | "connected"
  | "disconnected"
  | "error";

export interface VsCodeTunnelStartResult {
  status: VsCodeTunnelStatus;
  tunnelName: string;
}

export interface VsCodeTunnelEvent {
  status: VsCodeTunnelStatus;
  deviceCode?: string;
  verificationUri?: string;
  tunnelName?: string;
  tunnelUrl?: string;
  error?: string;
  details?: string;
}

export interface VsCodeTunnelManager {
  start(): Promise<VsCodeTunnelStartResult>;
  stop(): Promise<void>;
  unregister(): Promise<void>;
  getStatus(): VsCodeTunnelStatus;
  shutdown(): Promise<void>;
}
```

No signatures change. No new statuses. No removed fields.

## `start()` — re-entry contract

**Preconditions**: none. Safe to call in any state.

**Postconditions**:
| Pre-call state                                   | Post-call outcome                                                                                     |
|:-------------------------------------------------|:-----------------------------------------------------------------------------------------------------|
| `child === null`, any `status`                   | Fresh `code tunnel` child spawned; `status = "starting"`; emit `{ status: "starting", tunnelName }`. Returns `{ status: "starting", tunnelName }`. |
| `child !== null`, `status === "authorization_pending"` and stored device code | No spawn. Re-emits stored `authorization_pending` event. Returns current `{ status, tunnelName }`. |
| `child !== null`, `status === "connected"`       | No spawn. Re-emits stored `connected` event with actual (URL-derived) `tunnelName` if different. Returns current `{ status, tunnelName }`. |
| `child !== null`, `status ∈ { "error", "disconnected", "stopped" }` (**recovery path — FR-003**) | Blocks up to `forceKillTimeoutMs = 5000` (SIGTERM → SIGKILL) awaiting stale child exit, then fresh-spawns as if `child === null`. Emits `{ status: "starting", tunnelName }` after the stale child's exit. |

**Return type**: `Promise<{ status: VsCodeTunnelStartResult; tunnelName: string }>`.

**Concurrency guarantee**: at most one `code tunnel --name <opts.tunnelName>` process exists at any instant across the manager's lifetime. If a caller invokes `start()` while a stale child is still running, `await stop()` runs to completion before `spawn()` is called (Q4→A, #743).

## `stop()` — contract (unchanged)

**Preconditions**: none.

**Postconditions**:
- If `child === null`: resolves immediately, no-op.
- If `child !== null`: sets `stopping = true`, sends `SIGTERM` to the child. If the child does not exit within `forceKillTimeoutMs = 5000`, sends `SIGKILL`. Resolves when the child's `exit` event fires. Final `status = "stopped"`; no `error` event emitted from the exit path (the `stopInitiated` branch runs).

## `cluster.vscode-tunnel` event stream — invariants after the fix

For each failed start attempt hitting the device-code timeout, the cloud receives **exactly one** `error` event with the following payload shape:

```json
{
  "status": "error",
  "error": "Timed out waiting for device code",
  "details": "<last 20 stdout lines from the child, joined with \\n>",
  "tunnelName": "<opts.tunnelName>"
}
```

The `"code tunnel exited (code N) before reaching connected state"` text is not emitted on the timeout path (the exit handler's `wasPending` branch is suppressed by the new `timedOut` flag). It continues to be emitted for genuine unexpected child exits before reaching connected state, when the manager did **not** initiate the kill.

For a successful attempt on a clean manager (no stale state), the event sequence is unchanged:
```
1. { status: "starting", tunnelName }
2. { status: "authorization_pending", deviceCode, verificationUri, tunnelName }
3. { status: "connected", tunnelName, tunnelUrl }
```

For a stale-child recovery (FR-003 branch of `start()`), the caller-observable stream is:
```
(silent — stale child's exit routes to "stopped" via stopping = true, no event)
1. { status: "starting", tunnelName }   // fresh spawn
...
```

## `getStatus()` — snapshot semantics

| Manager lifecycle stage                                | `getStatus()` returns |
|:------------------------------------------------------|:----------------------|
| Never started                                          | `"stopped"`           |
| `start()` returned, no device code yet                 | `"starting"`          |
| Device code parsed from stdout                         | `"authorization_pending"` |
| Tunnel URL parsed from stdout                          | `"connected"`         |
| Connected child exited unexpectedly                    | `"disconnected"`      |
| Device-code timeout fired and cascade completed **(post-fix)** | `"error"`             |
| Non-connected child exited unexpectedly (not our kill) | `"error"`             |
| `stop()` completed                                     | `"stopped"`           |

The `"error"` status persists until the next `start()` invocation. It is user-visible in `/health` and any UI that polls `getStatus()`. It is not "cleared" by subsequent successful starts — a new `start()` first transitions to `"starting"`, then walks the normal state machine.

## Kill sequencing (internal but load-bearing)

Two independent SIGTERM → SIGKILL cascades exist in the manager. Both use `forceKillTimeoutMs = 5000`:

1. **`stop()`** — user-initiated. `stopping = true`, then SIGTERM, then SIGKILL if the child does not exit within the window. Exit handler resets to `status = "stopped"`.
2. **Device-code timeout — post-fix** — self-initiated. `status = "error"`, emit the single `error` event, set `timedOut = true`, then SIGTERM with SIGKILL backstop. Exit handler skips the `wasPending` emit; final state is `status = "error"`, `child = null`.

These cascades are independent flags (`stopping` vs `timedOut`) so a race between the two resolves cleanly — the exit handler cascade checks `stopping` first (user's intent wins), then `timedOut`. See `data-model.md` §"Exit-handler branching table".

## Non-goals of this contract

- **No cross-restart persistence.** `status = "error"` is process-lifetime only; a control-plane restart resets to `"stopped"`.
- **No exposure of the `timedOut` flag** to the public API. It is a private mechanism to route the exit-handler cascade; callers only see the observable outcome (one `error` event, `getStatus() === "error"`).
- **No change to `deviceCodeTimeoutMs = 30_000` or `forceKillTimeoutMs = 5_000`.** Constants are load-bearing on cloud UX expectations and are explicitly out of scope (spec §Out of Scope).
- **No cloud-side stop-then-start.** FR-006 optional companion tweak in generacy-cloud is deferrable and orthogonal to this contract.
