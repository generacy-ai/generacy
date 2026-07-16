# Contract: `VsCodeTunnelProcessManager` (modified)

Module: `packages/control-plane/src/services/vscode-tunnel-manager.ts` (MOD)

## New exports

```ts
export const DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS: 300_000;
```

## Modified interfaces

```ts
export interface VsCodeTunnelManagerOptions {
  binPath: string;
  tunnelName: string;
  forceKillTimeoutMs?: number;
  deviceCodeTimeoutMs?: number;
  authTimeoutMs?: number;                // NEW — FR-004
}
```

No changes to `VsCodeTunnelEvent`, `VsCodeTunnelStatus`, `VsCodeTunnelStartResult`, or `VsCodeTunnelManager`. Wire format with cloud is unchanged.

## Behavior — `start()` (MOD)

### Existing live-child early-return branch (line 143-163) is extended

Original branches (unchanged):
- `status === 'authorization_pending' && deviceCode != null` → re-emit cached `authorization_pending` payload with deviceCode + verificationUri.
- `status === 'connected'` → re-emit cached `connected` payload with tunnelUrl.

New branch inserted **before** the two existing ones (order matters — `authorization_pending` case above already excludes the `deviceCode == null` sub-case):

```ts
} else if (this.status === "starting") {
  emitTunnelEvent({
    status: "starting",
    tunnelName: this.opts.tunnelName,
  });
}
```

Postcondition: every call to `start()` on a live child emits exactly one status event.

### Return value

Unchanged:

```ts
return {
  status: this.status,
  tunnelName: this.actualTunnelName ?? this.opts.tunnelName,
};
```

## Behavior — new `authTimer` (FR-004)

### Arming

At the `starting → authorization_pending` transition in `handleStdoutLine`:

```ts
if (codeMatch && this.status === "starting") {
  this.clearDeviceCodeTimer();
  this.status = "authorization_pending";
  this.deviceCode = codeMatch[1] ?? null;
  this.verificationUri = "https://github.com/login/device";
  this.armAuthTimer(child);                                  // ← NEW
  emitTunnelEvent({ ... });
}
```

`armAuthTimer(child)`:
- Reads `authTimeoutMs` from options (default `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS`).
- Idempotent: if `this.authTimer != null`, returns.
- Calls `timer.unref()` so a leaked timer does not keep the event loop alive.

### Firing

When the timer expires:
1. Guard: if `this.status !== 'authorization_pending'`, return (no-op — a terminal transition already happened).
2. Set `this.status = 'error'`.
3. Emit exactly one lifecycle `error` event with `error: "Timed out waiting for device-code authorization"` and up-to-20-line `details` from the stdout buffer.
4. Set `this.timedOut = true` to route the subsequent exit through the timedOut cascade (exit handler suppresses the wasPending duplicate emit).
5. `child.kill('SIGTERM')`. Arm a `SIGKILL` backstop timer with `forceKillTimeoutMs`.

### Clearing

`clearAuthTimer()` is called at every existing `clearDeviceCodeTimer()` call site:
- exit handler (~line 191)
- connected transition (~line 411)
- `child.on('error', ...)` (~line 230)
- `stop()` — via `clearDeviceCodeTimer()` at line 295 (add `clearAuthTimer()` sibling)

## Invariants (post-change)

- **T1** — `deviceCodeTimer` and `authTimer` are never both non-null simultaneously.
- **T2** — Both timers are always cleared before the exit handler completes.
- **T3** — Neither timer keeps the Node event loop alive (both `unref()`'d).
- **T4** — A `starting → authorization_pending` transition ALWAYS arms `authTimer` (except when the code path is being torn down).
- **T5** — The `timedOut` field is set only by timer expiry paths (starting-phase timeout or new auth-phase timeout) and cleared at the top of the exit handler.

## Backward compatibility

- No changes to `VsCodeTunnelManager` interface. Consumers of `getVsCodeTunnelManager()` see identical shape.
- No changes to `cluster.vscode-tunnel` wire payload — `emitTunnelEvent` payload shape unchanged.
- New option `authTimeoutMs` is optional; existing constructors and `loadOptionsFromEnv()` unchanged (env var override deferred — tests inject directly).
- New export `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS` is additive.

## Test seams

- `authTimeoutMs: 50` for fast-timer tests (matches existing `deviceCodeTimeoutMs: 50` idiom in `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts`).
- `vi.useFakeTimers()` + `vi.advanceTimersByTime(51)` — advances past both starting and auth timers deterministically.
- Existing `getRelayPushEventMock` captures emitted events; new tests assert exact call sequences (e.g., "exactly one `starting` event when re-triggered mid-startup, no additional `spawn`").
