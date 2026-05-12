# Quickstart: VS Code Tunnel Device Code Race Condition Fix

## What Changed

`VsCodeTunnelProcessManager.start()` now re-emits the current tunnel state event when called idempotently (tunnel already running). This fixes the race condition where opening the VS Code Desktop dialog after bootstrap-complete auto-start would never show the device code.

## Files Modified

1. `packages/control-plane/src/services/vscode-tunnel-manager.ts` — Store device code fields, re-emit on idempotent `start()`
2. `packages/control-plane/__tests__/vscode-tunnel-manager.test.ts` — New test cases for re-emission behavior

## Running Tests

```bash
cd packages/control-plane
pnpm test -- --run vscode-tunnel-manager
```

## Manual Test Plan

### Test 1: Late dialog opening (primary fix)
1. Bootstrap a cluster (or trigger `bootstrap-complete` lifecycle action)
2. Wait 30+ seconds (tunnel auto-starts during bootstrap)
3. Open the VS Code Desktop dialog in the cloud UI
4. Click "Start Tunnel"
5. **Expected**: Device code appears within ~1 second

### Test 2: Immediate dialog opening (no regression)
1. Bootstrap a cluster
2. Open the VS Code Desktop dialog immediately
3. Click "Start Tunnel"
4. **Expected**: Device code appears within ~5 seconds (live from stdout)

### Test 3: Post-authentication reconnect
1. Complete the device code flow (tunnel connects)
2. Close and reopen the dialog
3. Click "Start Tunnel"
4. **Expected**: Dialog shows "Open in VS Code Desktop" immediately (connected state re-emitted)

## Troubleshooting

### Device code not appearing
- Check IPC channel: control-plane must have `ORCHESTRATOR_INTERNAL_API_KEY` set
- Verify `code tunnel` process is running: check control-plane logs for spawn events
- Confirm relay events are flowing: check orchestrator `/internal/relay-events` endpoint

### Stale device code after timeout
- Device codes expire after ~15 minutes. If the tunnel process is still in `authorization_pending` state with an expired code, stop and restart the tunnel via the dialog's Stop/Start buttons.
