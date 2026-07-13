# Feature Specification: ## Summary

The cloud **Restart tunnel** button on the project page can silently do nothing

**Branch**: `825-summary-cloud-restart-tunnel` | **Date**: 2026-07-07 | **Status**: Draft

## Summary

## Summary

The cloud **Restart tunnel** button on the project page can silently do nothing. Once
the tunnel manager lands in a specific error state, every subsequent start request is a
no-op until the control-plane process (or container) restarts. This is the likely
reason "restarting the tunnel from the UI doesn't work" when users hit it.

## Root cause

Two interacting facts:

1. The UI **Restart** only calls `vscode-tunnel-start` — it never calls
   `vscode-tunnel-stop` first:
   - `generacy-cloud` → `packages/web/src/lib/hooks/use-vscode-tunnel.ts`
     (`startTunnel()` POSTs `.../relay/control-plane/lifecycle/vscode-tunnel-start`).

2. In `VsCodeTunnelProcessManager`
   (`packages/control-plane/src/services/vscode-tunnel-manager.ts`), the 30s
   device-code timeout sets `status = "error"` but does **not** kill the child or clear
   `this.child`:

   ```ts
   this.deviceCodeTimer = setTimeout(() => {
     if (this.status === "starting") {
       this.status = "error";
       // ... emit error ...
     }
   }, timeoutMs);   // no child.kill(), no this.child = null
   ```

   `start()` guards on `this.child`:

   ```ts
   async start() {
     if (this.child) {
       // only re-emits for authorization_pending / connected
       return { status: this.status, tunnelName: ... };   // ← no-op when status === "error"
     }
     // ... spawn ...
   }
   ```

So if a start attempt reaches the device-code timeout (child still alive but never
produced a device code or a "connected" line within 30s), the manager is left with
`status = "error"` **and** a live `this.child`. A subsequent `start()` (the Restart
button) hits the early-return and does nothing — the orphaned process is never replaced.

## Impact

- UI **Restart** appears dead; the user sees no state change and cannot recover the
  tunnel from the project page.
- Only recovered by restarting the control-plane / orchestrator container.

## Proposed fix

- In the device-code timeout handler, treat it like a failed start: `child.kill()`
  (SIGTERM → SIGKILL) and let the exit handler clear `this.child`, or set
  `this.child = null` after killing, so a later `start()` respawns.
- Harden `start()`: if `this.child` exists but `status` is `error` / `disconnected` /
  `stopped`, replace it (stop-then-spawn) instead of returning.
- Optional (defense in depth): make the cloud **Restart** perform stop-then-start.

## Related

- Companion / primary bug: **the tunnel never auto-restarts after a cluster stop/start**
  (filed separately) — that is why users reach for the Restart button in the first place.
- **#604** (device-code emit-before-subscribe race; idempotent restart couldn't
  re-emit) touched this same `start()` early-return path.

## Scope

`generacy` repo — `packages/control-plane/src/services/vscode-tunnel-manager.ts`.
Optional companion tweak in `generacy-cloud`
(`packages/web/src/lib/hooks/use-vscode-tunnel.ts`) to stop-then-start.


## User Stories

### US1: Recover a stalled tunnel from the cloud Restart button

**As a** developer using the generacy-cloud project page,
**I want** the **Restart tunnel** button to reliably respawn the `code tunnel` child even
after a prior start attempt hit the 30s device-code timeout,
**So that** I can recover the tunnel from the UI without asking an operator to restart
the control-plane container.

**Acceptance Criteria**:
- [ ] When a first `vscode-tunnel-start` fails at the device-code timeout, the manager
      finishes cleanup with `this.child === null` and `getStatus() === "error"`.
- [ ] Clicking **Restart tunnel** (a subsequent `vscode-tunnel-start` call) spawns a
      fresh `code tunnel` process — no early-return, no orphan.
- [ ] The cloud UI observes exactly one `error` event per failed start attempt on
      `cluster.vscode-tunnel`, with message `"Timed out waiting for device code"`.
- [ ] Even without the optional cloud-side stop-then-start change, the button works
      after a single click.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | On device-code timeout, `VsCodeTunnelProcessManager` MUST set `status = "error"`, emit the single `error` event on `cluster.vscode-tunnel`, set a dedicated `timedOut = true` flag, then call `child.kill()` (SIGTERM → SIGKILL). | P1 | Clarify Q1=B. Dedicated flag — do NOT reuse `stopping`. |
| FR-002 | The child-`exit` handler MUST detect `timedOut === true`, skip its `wasPending` error emit, and leave `status = "error"` intact while clearing `this.child` to `null`. | P1 | Clarify Q1=B, Q2=A, Q3=A. Prevents the second/duplicate error event and preserves the actionable timeout message. |
| FR-003 | `start()` MUST respawn from any resting state where `this.child` exists but `status ∈ { "error", "disconnected", "stopped" }` by first `await stop()` (up to `forceKillTimeoutMs = 5000`, SIGTERM → SIGKILL) and then spawning a fresh child. | P1 | Clarify Q4=A. Defense-in-depth; ensures no two `code tunnel --name <same>` processes overlap (see #743). |
| FR-004 | After a device-code timeout has fully settled (timeout handler + child exit), `manager.getStatus()` MUST return `"error"` until the next `start()` call. | P1 | Clarify Q2=A. `"error"` stays user-visible; recovery already permitted by FR-003. |
| FR-005 | For each failed start attempt, exactly one `error` event MUST be emitted on `cluster.vscode-tunnel`, with `error: "Timed out waiting for device code"` and the timeout handler's last-stdout-lines in `details`. | P1 | Clarify Q3=A. Suppress the child-exit `wasPending` emit; keep the timer's proximal-cause message. |
| FR-006 | Optional companion (out of `packages/control-plane` scope): the cloud **Restart** hook MAY POST `vscode-tunnel-stop` before `vscode-tunnel-start`. Not required for the fix to work. | P3 | Defense-in-depth in `generacy-cloud/packages/web/src/lib/hooks/use-vscode-tunnel.ts`. Filed separately; deferrable. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Restart recovers from device-code-timeout state | 100% of the time on a single Restart click, no container restart required | Reproduce the timeout (e.g., block outbound to Microsoft's device-code endpoint for 30s), observe the emitted `error` event, click Restart, confirm a fresh `code tunnel` child spawns and transitions past `starting`. |
| SC-002 | No duplicate error events per failed attempt | Exactly one `error` event on `cluster.vscode-tunnel` per timeout | Capture the relay event stream during a timeout; assert length 1 with message `"Timed out waiting for device code"`. |
| SC-003 | No concurrent `code tunnel` processes with the same `--name` | Zero overlap window | While Restart runs against a stale child, verify only one `code tunnel` process exists at any instant (e.g., `ps` snapshot loop, or unit test asserting `await stop()` resolves before `spawn()`). |

## Assumptions

- The `code tunnel` CLI at `VSCODE_CLI_BIN` (default `/usr/local/bin/code`) accepts
  SIGTERM cleanly within the 5s `forceKillTimeoutMs` window; SIGKILL is the backstop.
- The relay event delivery is best-effort (existing behavior); "exactly one" refers to
  what the manager emits, not what the cloud ultimately receives after network loss.
- Cloud-side Restart callers already treat `vscode-tunnel-start` as an async operation
  and tolerate the up-to-5s wait introduced by `await stop()` in FR-003.
- The bootstrap-complete auto-start path (control-plane `lifecycle.ts`) uses the same
  `start()` entry, so this fix also hardens the initial-boot case, not just Restart.

## Out of Scope

- The primary reason the tunnel is down after a cluster stop/start (auto-restart on
  reconnect) — tracked separately in **#824**.
- Cloud UI behavior beyond the optional FR-006 stop-then-start tweak; the fix in
  `packages/control-plane` is sufficient on its own.
- Changing the 30s `deviceCodeTimeoutMs` constant or the `forceKillTimeoutMs = 5000`
  value.
- Persisting or reporting error state across control-plane restarts (out of the
  process-lifetime scope of `VsCodeTunnelProcessManager`).

---

*Generated by speckit*
