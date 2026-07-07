# Data Model: Restart-tunnel silently no-ops after device-code timeout

**Feature**: `825-summary-cloud-restart-tunnel` | **Date**: 2026-07-07

This is a bug fix. It changes no wire schemas, no persisted types, and no public method signatures on `VsCodeTunnelManager`. The section below documents the private-state delta on `VsCodeTunnelProcessManager`, the exit-handler branching table, and the delta in the emitted `cluster.vscode-tunnel` event stream.

## Types touched

### `VsCodeTunnelProcessManager` — private state

**Before** (`packages/control-plane/src/services/vscode-tunnel-manager.ts:97-113`):
```ts
export class VsCodeTunnelProcessManager implements VsCodeTunnelManager {
  private child: ChildProcess | null = null;
  private status: VsCodeTunnelStatus = "stopped";
  private exitWaiters: Array<() => void> = [];
  private deviceCodeTimer: NodeJS.Timeout | null = null;
  private stdoutBuffer: string[] = [];
  private deviceCode: string | null = null;
  private verificationUri: string | null = null;
  private tunnelUrl: string | null = null;
  private actualTunnelName: string | null = null;
  private stopping = false;
  // ...
}
```

**After**:
```ts
export class VsCodeTunnelProcessManager implements VsCodeTunnelManager {
  private child: ChildProcess | null = null;
  private status: VsCodeTunnelStatus = "stopped";
  private exitWaiters: Array<() => void> = [];
  private deviceCodeTimer: NodeJS.Timeout | null = null;
  private stdoutBuffer: string[] = [];
  private deviceCode: string | null = null;
  private verificationUri: string | null = null;
  private tunnelUrl: string | null = null;
  private actualTunnelName: string | null = null;
  private stopping = false;
  private timedOut = false;   // NEW — set true by the device-code timeout handler before it kills the child; read + cleared by the exit handler to suppress the wasPending error emit
  // ...
}
```

One added field. No renames, no removals.

### Public interfaces — `VsCodeTunnelManager`, `VsCodeTunnelStatus`, `VsCodeTunnelEvent`, `VsCodeTunnelStartResult`

**Unchanged.** No new statuses, no new event fields, no new method signatures. The fix is entirely internal to `VsCodeTunnelProcessManager`.

- `VsCodeTunnelStatus = "stopped" | "starting" | "authorization_pending" | "connected" | "disconnected" | "error"` — same 6 values, same semantics.
- `VsCodeTunnelEvent = { status; deviceCode?; verificationUri?; tunnelName?; tunnelUrl?; error?; details? }` — unchanged shape.
- `start()`, `stop()`, `shutdown()`, `unregister()`, `getStatus()` — signatures unchanged.

## Call graph delta

### Device-code timeout — before (bug)

```text
setTimeout(() => {
  if (this.status === "starting") {
    this.status = "error"
    emit error "Timed out waiting for device code"
  }
}, 30_000)
// child STAYS ALIVE. this.child STAYS SET.
// Next start() sees this.child, hits the early-return, does nothing.
```

### Device-code timeout — after (fix)

```text
setTimeout(() => {
  if (this.status === "starting") {
    this.status = "error"
    emit error "Timed out waiting for device code" (with details = last 20 stdout lines, tunnelName)
    this.timedOut = true
    this.child?.kill("SIGTERM")
    setTimeout(() => this.child?.kill("SIGKILL"), forceKillTimeoutMs)  // SIGKILL backstop
  }
}, 30_000)
// child exits (from SIGTERM or SIGKILL).
// Exit handler sees timedOut === true, skips the second error emit,
// clears this.child = null, leaves status = "error".
// Next start() sees this.child === null and spawns cleanly.
```

### Child-`exit` handler — before

```text
child.on("exit", (code) => {
  const wasConnected = status === "connected"
  const wasPending = status === "authorization_pending" || status === "starting"
  const stopInitiated = this.stopping
  this.stopping = false
  this.child = null
  clearDeviceCodeTimer(); clear deviceCode/uri/tunnelUrl/actualTunnelName

  if (stopInitiated)      status = "stopped"
  else if (wasConnected)  { status = "disconnected"; emit disconnected }
  else if (wasPending)    { status = "error"; emit error "code tunnel exited (code N) before reaching connected state" }
  else                    status = "stopped"

  run exitWaiters
})
```

### Child-`exit` handler — after

```text
child.on("exit", (code) => {
  const wasConnected  = status === "connected"
  const wasPending    = status === "authorization_pending" || status === "starting"
  const stopInitiated = this.stopping
  const timedOut      = this.timedOut       // NEW
  this.stopping = false
  this.timedOut = false                     // NEW — clear at handler entry
  this.child = null
  clearDeviceCodeTimer(); clear deviceCode/uri/tunnelUrl/actualTunnelName

  if (stopInitiated)      status = "stopped"
  else if (timedOut)      /* NEW — keep status = "error"; SUPPRESS the emit */
  else if (wasConnected)  { status = "disconnected"; emit disconnected }
  else if (wasPending)    { status = "error"; emit error "code tunnel exited (code N)…" }
  else                    status = "stopped"

  run exitWaiters
})
```

### Exit-handler branching table (post-fix)

| `stopping` | `timedOut` | pre-exit `status` | resulting `status` | emitted event                                                                      |
|:-----------|:-----------|:------------------|:-------------------|:------------------------------------------------------------------------------------|
| `true`     | `*`        | any               | `"stopped"`        | (none — user-initiated stop is quiet)                                              |
| `false`    | `true`     | any (was set to `"error"` by timeout handler) | `"error"` | (none in exit handler — the timeout handler already emitted the single `error`)     |
| `false`    | `false`    | `"connected"`     | `"disconnected"`   | `disconnected`                                                                     |
| `false`    | `false`    | `"authorization_pending"` or `"starting"` | `"error"` | `error: "code tunnel exited (code N) before reaching connected state"` (existing) |
| `false`    | `false`    | any other         | `"stopped"`        | (none)                                                                             |

`stopping` takes precedence over `timedOut` because `stop()` is user-initiated and should always cleanly reset; a `stop()` racing a timeout is exotic but if it happens the user's intent wins.

### `start()` early-return path — before (bug)

```text
async start() {
  if (this.child) {
    if (status === "authorization_pending" && deviceCode) emit auth_pending
    else if (status === "connected") emit connected
    return { status, tunnelName }                        // ← no-op when status === "error" + child set
  }
  spawn(...)
}
```

### `start()` early-return path — after (fix, defense-in-depth)

```text
async start() {
  if (this.child) {
    if (status === "error" || status === "disconnected" || status === "stopped") {   // NEW branch — FR-003
      await this.stop()                                                              // NEW — ≤5s SIGTERM→SIGKILL, clears this.child
      // fall through to spawn below
    } else {
      if (status === "authorization_pending" && deviceCode) emit auth_pending
      else if (status === "connected") emit connected
      return { status, tunnelName }
    }
  }
  spawn(...)
}
```

Structurally: the existing "if `this.child`" block is split into "recover if resting-error" (new) and "re-emit if live" (existing). The fresh-spawn path is unchanged.

## Emitted event stream delta

Only one observable change: **the second `error` event is suppressed on the timeout path.**

### Timeout scenario — before (bug)

```
1. { status: "starting", tunnelName }
2. { status: "error", error: "Timed out waiting for device code", details }
   (child still alive, this.child still set)
```
Then, on later Restart:
```
(no new events — start() early-returns; child NEVER killed until container restarts)
```

### Timeout scenario — after (fix)

```
1. { status: "starting", tunnelName }
2. { status: "error", error: "Timed out waiting for device code", details, tunnelName }   // ← now includes tunnelName for parity with other error events
3. (child killed by SIGTERM; exit handler suppresses second error emit; status stays "error", this.child = null)
```
Then, on Restart:
```
4. { status: "starting", tunnelName }   // fresh spawn — FR-003 defense-in-depth is not triggered because this.child was cleared cleanly by fix (2), but if it wasn't, the await stop() branch would run silently first
5. { status: "authorization_pending", deviceCode, verificationUri, tunnelName } | ...
```

The cloud UI (`use-vscode-tunnel.ts` in generacy-cloud) already handles this event shape; there is no cloud-side subscription change required.

## Validation / Invariants

- **After the timeout handler runs**: `status === "error"`, `timedOut === true`, `this.child !== null` (kill signal sent, not yet received). Exactly one `error` event has been emitted on `cluster.vscode-tunnel`.
- **After the exit handler runs following the timeout**: `status === "error"`, `timedOut === false`, `this.child === null`. **Total** `error` events on this attempt: exactly 1. (SC-002.)
- **On a subsequent `start()` after a settled timeout**: `spawn` is called once. No `await stop()` needed (defense-in-depth branch skipped because `this.child === null`). (SC-001.)
- **On a subsequent `start()` when some future bug leaves `this.child !== null` with `status === "error"`**: `await stop()` runs, sends `SIGTERM` → SIGKILL if needed, clears `this.child`, then `spawn` is called. Only one `code tunnel --name <same>` process exists at any instant. (SC-003.)
- **User-initiated `stop()` during a timeout race**: `this.stopping` takes precedence in the exit-handler cascade — `status` resets to `"stopped"` and no `error` event is emitted from the exit handler. The timeout handler may still have emitted its `error` before the race resolved; that is a pre-existing race not addressed by this fix (spec §Out of Scope for concurrency polish beyond the timeout gap).

## Backward-compat / migration

- **Public interface**: unchanged. Callers of `VsCodeTunnelManager` (i.e. `packages/control-plane/src/routes/lifecycle.ts` for both `vscode-tunnel-start` and `vscode-tunnel-stop`) require no changes.
- **Wire events**: unchanged shape. The timeout `error` event gains a `tunnelName` field it did not previously carry, but the field is optional in `VsCodeTunnelEvent` and cloud consumers already ignore extra fields (see `use-vscode-tunnel.ts` — schema is loose over `.status`/`.error`).
- **Cloud UI**: no changes required. FR-006 (optional stop-then-start on Restart click) is deferrable and is filed as a companion issue.
- **Persistence**: none. Manager is process-lifetime only.
- **Bootstrap-complete auto-start path**: same `start()` entry, so the fix also hardens the initial-boot case, not just Restart (spec §Assumptions).

## Test surface

Extension points, all under `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` (the existing 940-LOC file):

- `describe("device code timeout")` — extend with:
  - Timeout handler sends `SIGTERM` to the child (FR-001).
  - Timeout `error` event now includes `tunnelName` (data-model.md §"Timeout scenario — after").
  - Simulated `child.emit("exit")` after timeout does NOT emit a second `error` event (FR-005, SC-002).
  - After timeout + exit, `getStatus() === "error"` and `this.child === null` (FR-004).
  - After timeout + exit, a subsequent `mgr.start()` calls `spawnMock` a second time (FR-001+FR-002 wiring, SC-001).
  - Timeout emits ONE `error` event with the timeout text, never the `"code tunnel exited (code N)…"` text (FR-005, Q3→A).
- `describe("start() idempotency")` — extend with:
  - When `this.child` exists but `status === "error"`, `start()` calls `stop()` first, then spawns (FR-003, SC-003).
  - Same for `status === "disconnected"` and `status === "stopped"` (FR-003 recovery states).
  - The `await stop()` completes before `spawn` is called (no concurrent `code tunnel` processes — assert the ordering with `spawnMock.mock.invocationCallOrder` vs `child.kill.mock.invocationCallOrder`).
- `describe("shutdown()")` — no change; already covered by the existing test.

No new test files. No changes to helpers (`createMockChild`, `pushLine`, `defaultOpts`) required.
