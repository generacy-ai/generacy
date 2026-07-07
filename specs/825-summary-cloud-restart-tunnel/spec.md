# Feature Specification: Recover VS Code Tunnel After Device-Code Timeout

**Branch**: `825-summary-cloud-restart-tunnel` | **Date**: 2026-07-07 | **Status**: Draft
**Issue**: [#825](https://github.com/generacy-ai/generacy/issues/825)
**Type**: Bug fix

## Summary

The cloud **Restart tunnel** button on the project page can silently no-op. Once
`VsCodeTunnelProcessManager` lands in `status = "error"` with a live child (the
30s device-code timeout path), every subsequent `start()` call hits the
`if (this.child)` early-return and does nothing. The only recovery today is
restarting the control-plane container. This spec covers the cluster-side fix
so the UI Restart button becomes reliable end-to-end.

## Root Cause

`packages/control-plane/src/services/vscode-tunnel-manager.ts`, two interacting
facts:

1. **Device-code timeout leaves the child alive.** The 30s timer sets
   `this.status = "error"` and emits an error event, but does not call
   `child.kill()` and does not clear `this.child`
   (`vscode-tunnel-manager.ts:235-247`).

2. **`start()` early-returns whenever a child exists.** If `this.child`
   is non-null, `start()` re-emits `authorization_pending` or `connected`
   and returns — but for `status = "error"` it just returns the error state
   without spawning a replacement (`vscode-tunnel-manager.ts:125-146`).

Result: after a stuck device-code attempt, the manager holds an orphaned
`code tunnel` child and reports `status = "error"`. The UI's Restart button
(which only calls `POST /lifecycle/vscode-tunnel-start`, never
`vscode-tunnel-stop` first) hits the early-return and the user sees no
state change.

## User Stories

### US1: Reliable UI Restart after a stuck tunnel

**As a** Generacy user whose VS Code tunnel got stuck during device-code
authorization,
**I want** the **Restart tunnel** button on the project page to actually
respawn the tunnel,
**So that** I can recover the IDE link without asking an operator to restart
the container.

**Acceptance Criteria**:
- [ ] After a device-code timeout leaves the manager in `status = "error"`,
  a subsequent `start()` call spawns a fresh `code tunnel` child and emits a
  new `starting` event on `cluster.vscode-tunnel`.
- [ ] The orphaned child from the timed-out attempt is terminated (no
  duplicate `code tunnel` processes remain).
- [ ] The manager reaches `authorization_pending` (or `connected`) on the
  retry if the underlying environment is healthy.
- [ ] No regression to the happy path: a Restart while `status = "connected"`
  still re-emits the current `connected` event without respawning.

### US2: No orphaned tunnel processes

**As a** cluster operator,
**I want** timed-out `code tunnel` attempts to leave no leftover child
processes,
**So that** the container's process table doesn't accumulate zombies and a
future `start()` doesn't race a stale process for the tunnel name.

**Acceptance Criteria**:
- [ ] After the device-code timeout fires, the `code tunnel` PID no longer
  exists (SIGTERM, escalating to SIGKILL after the standard force-kill
  window).
- [ ] `this.child` is cleared before the next `start()` runs (either via the
  exit handler or explicit reset in the timeout branch).

## Functional Requirements

| ID     | Requirement                                                                                                                                                             | Priority | Notes |
|--------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|-------|
| FR-001 | On device-code timeout, `VsCodeTunnelProcessManager` MUST terminate the child process (SIGTERM, then SIGKILL after `forceKillTimeoutMs`) in addition to setting `status = "error"`. | P1 | Bug fix core |
| FR-002 | On device-code timeout, `this.child` MUST be cleared (directly or via the exit handler) so a subsequent `start()` respawns instead of early-returning. | P1 | Bug fix core |
| FR-003 | `start()` MUST spawn a fresh child when `this.status ∈ {error, disconnected, stopped}`, even if a stale `this.child` reference somehow remains. It MUST stop-then-spawn in that case, not just spawn on top. | P1 | Defense in depth against any future path that also fails to clear `child` |
| FR-004 | `start()` MUST continue to be a re-emit-only no-op when `this.status ∈ {starting, authorization_pending, connected}`. Idempotent restart in healthy states is preserved (per #604). | P1 | Regression guard |
| FR-005 | The timeout handler MUST emit exactly one `error` event on `cluster.vscode-tunnel` (no duplicate error emissions when the killed child's `exit` handler fires). | P2 | Cosmetics — avoid double-error in cloud UI |
| FR-006 | `stop()` behavior for an already-stopped or errored manager MUST remain a safe no-op (existing contract). | P2 | Regression guard |

## Success Criteria

| ID     | Metric                                                                                                              | Target                                     | Measurement |
|--------|---------------------------------------------------------------------------------------------------------------------|--------------------------------------------|-------------|
| SC-001 | UI **Restart tunnel** recovers a stuck (device-code-timed-out) tunnel without container restart.                    | 100% in manual repro                       | Manual test: force a 30s timeout (block network to `github.com/login/device`), then click Restart. New `starting` event appears within 2s. |
| SC-002 | Zero orphaned `code tunnel` PIDs after a device-code timeout.                                                       | 0 processes                                | `pgrep -f 'code tunnel'` after 60s of a timed-out attempt returns nothing. |
| SC-003 | Idempotent restart in healthy state still re-emits without side effects (no regression from #604).                  | 100%                                       | Call `start()` while `connected`; assert no new spawn and a `connected` event is re-emitted. |
| SC-004 | New test coverage for the timeout→restart path in `vscode-tunnel-manager.test.ts`.                                  | ≥ 2 new tests                              | Vitest: (a) timeout kills child + clears `child`; (b) `start()` after timeout spawns a fresh child. |

## Assumptions

- The device-code timeout (`DEFAULT_DEVICE_CODE_TIMEOUT_MS = 30_000`) stays
  at 30s. This spec does not tune the timeout value.
- The cloud UI's Restart button continues to send only `vscode-tunnel-start`.
  The stop-then-start companion tweak in `generacy-cloud` is optional
  defense-in-depth; the cluster-side fix must be sufficient on its own.
- The tunnel-name collision surfacing (#744 FR-012) and per-cluster tunnel
  name derivation stay as-is — this bug fix does not touch naming.
- Existing `stop()` semantics (SIGTERM → SIGKILL after `forceKillTimeoutMs`)
  are the correct model for the timeout path too.

## Out of Scope

- The companion bug "tunnel never auto-restarts after a cluster stop/start"
  (tracked separately). This spec only covers the manual **Restart** button
  path from an error state.
- Cloud-side (`generacy-cloud`) changes to make Restart perform
  stop-then-start. Optional; can be filed as a follow-up if desired.
- Tuning `DEFAULT_DEVICE_CODE_TIMEOUT_MS`.
- Rework of the `code tunnel` stdout parser or device-code emit-before-
  subscribe race handled by #604.
- Any changes to `unregister()` (destroy-path cleanup).

## Scope of Change

- **File**: `packages/control-plane/src/services/vscode-tunnel-manager.ts`
- **Tests**: `packages/control-plane/src/services/vscode-tunnel-manager.test.ts`
  (existing file; add cases for the new paths)

---

*Generated by speckit*
