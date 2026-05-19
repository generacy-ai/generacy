# Bug Fix: VS Code Tunnel Device Code Race Condition

**Branch**: `604-symptoms-after-all-594` | **Date**: 2026-05-12 | **Status**: Draft

## Summary

After bootstrap completes, the VS Code tunnel auto-starts and emits the `authorization_pending` device code event via SSE. When the user opens the "VS Code Desktop" dialog later, SSE only delivers *new* events — the device code event has already fired. The idempotent `start()` early-returns without re-emitting, leaving the dialog stuck on "Starting tunnel..." forever.

## Symptoms

- Fresh bootstrap completes, `code tunnel` process is running, IPC events flowed successfully
- User clicks "VS Code Desktop → Start Tunnel" — dialog spins on "Starting tunnel..." indefinitely
- Device code never appears in the dialog
- Verified on live cluster (`onboarding-test-8`): tunnel running, 6 successful IPC pushes, but dialog never receives them

## Root Cause — Auto-start vs Dialog Subscription Race

1. `bootstrap-complete` lifecycle action auto-starts the tunnel at `packages/control-plane/src/routes/lifecycle.ts:126-129`
2. Tunnel manager spawns `code tunnel`, parses device code from stdout within seconds, emits `authorization_pending` via relay → cloud → SSE
3. User opens the dialog later (10s–60s typical delay)
4. Dialog subscribes to `cluster:vscode-tunnel` SSE events — but SSE only delivers new events; `authorization_pending` already fired
5. `tunnelManager.start()` has `if (this.child) return` — early-returns because tunnel is already running, emits nothing
6. Dialog stuck on `tunnelState === 'starting'`

### Why persistent-status doesn't help

Firestore has `vscodeTunnelStatus: 'authorization_pending'` but the dialog's metadata handler only acts on `connected` and `error` — it ignores `authorization_pending` because the device code isn't (and shouldn't be) persisted in Firestore.

## User Stories

### US1: Late-opening dialog receives device code

**As a** developer who just bootstrapped a project,
**I want** the VS Code tunnel dialog to show the device code even when I open it after bootstrap completes,
**So that** I can authenticate and connect VS Code Desktop without restarting the tunnel.

**Acceptance Criteria**:
- [ ] Opening the dialog 30+ seconds after bootstrap shows the device code within ~1s
- [ ] Opening the dialog immediately after bootstrap shows the device code within ~5s (live from stdout)

### US2: Post-authentication dialog shows connected state

**As a** developer who already authenticated the tunnel,
**I want** the dialog to immediately show "Open in VS Code Desktop" when I reopen it,
**So that** I don't have to re-authenticate or wait.

**Acceptance Criteria**:
- [ ] Opening dialog after tunnel is `connected` skips device-code step and shows connection action
- [ ] Re-emitted `connected` event updates dialog state correctly

## Fix — Re-emit Current State on Idempotent `start()`

Two changes to `packages/control-plane/src/services/vscode-tunnel-manager.ts`:

### 1. Store device code as instance state

Add `deviceCode` and `verificationUri` private fields to `VsCodeTunnelProcessManager`. Populate when `handleStdoutLine` matches the device code pattern. Clear on tunnel exit or state transition away from `authorization_pending`.

### 2. Re-emit on idempotent `start()` call

When `start()` is called and the tunnel is already running, re-emit the current state event:
- `authorization_pending` → re-emit with stored `deviceCode` and `verificationUri`
- `connected` → re-emit connected event

This is the "newly-subscribed listener catches up" pattern from #541 Q3.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `VsCodeTunnelProcessManager` stores `deviceCode` and `verificationUri` as instance fields | P1 | Set when device code parsed from stdout |
| FR-002 | `deviceCode`/`verificationUri` cleared on tunnel exit or transition away from `authorization_pending` | P1 | Prevents stale data |
| FR-003 | Idempotent `start()` re-emits `authorization_pending` event with stored device code when tunnel is in that state | P1 | Core fix |
| FR-004 | Idempotent `start()` re-emits `connected` event when tunnel is in that state | P2 | Completeness |
| FR-005 | Fresh `start()` path unchanged — no behavioral regression | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Device code visible in dialog when opened after auto-start | 100% of attempts | Manual test: bootstrap → wait 30s → open dialog → click Start |
| SC-002 | No regression in fresh-start path | Passes existing test plan | Device code appears within ~5s on first open |
| SC-003 | Zero new fields persisted to Firestore | 0 | Code review — no Firestore writes for deviceCode |

## Alternatives Considered

- **Remove bootstrap auto-start** — Simpler but loses "tunnel ready when user opens dialog" UX. Asymmetric with code-server auto-start.
- **Persist deviceCode to Firestore** — Violates #541 Q1 hybrid design (transient data in events only). Creates stale device-code cleanup problem.
- **Frontend SSE event replay** — Cloud buffers last N events per cluster. Larger infrastructure change, overkill for this.

Re-emitting on idempotent start is the smallest, most architecturally-aligned fix.

## Test Plan

- [ ] Fresh bootstrap → auto-start fires → wait 30s → open dialog → click Start Tunnel → device code appears within ~1s
- [ ] Fresh bootstrap → open dialog immediately → click Start Tunnel → device code appears within ~5s (live from stdout)
- [ ] After connect: open dialog → re-emit fires `connected` → dialog shows "Open in VS Code Desktop"
- [ ] After error (device code timeout): re-emit fires error event with stored details

## Assumptions

- The `code tunnel` stdout device-code regex pattern is stable and already tested (#584)
- The relay IPC channel from control-plane to orchestrator is working correctly (#594, #598, #600, #602)
- SSE event delivery is fire-and-forget (no replay) — this is by design

## Out of Scope

- Cloud-side SSE event replay/buffering infrastructure
- Firestore schema changes for device code persistence
- Frontend `use-vscode-tunnel.ts` changes (fix is cluster-side only)
- Error-state re-emission beyond `authorization_pending` and `connected`

## Related Issues

- #584 — Introduced tunnel manager (device-code field was an oversight)
- #594 — IPC channel (working correctly)
- #602 — Wire shape fix (working correctly)
- #572 — Cluster ↔ cloud contract umbrella

---

*Generated by speckit*
