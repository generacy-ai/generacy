# Quickstart — VS Code Desktop tunnel retention (#966)

## What ships

Fix for "Connect with VS Code Desktop" hanging forever on fresh clusters. Three coordinated changes, all internal to the orchestrator + control-plane processes:

1. Orchestrator retains the latest actionable `cluster.vscode-tunnel` event when the relay is disconnected, and replays it on reconnect.
2. Control-plane's `VsCodeTunnelProcessManager.start()` emits a fresh `starting` event when a user re-triggers while the child is alive but has not yet parsed the device code.
3. `authorization_pending` phase is bounded by a new 300 s timeout; expiry emits a terminal `error` and tears down the child.

## Verification

### Manual repro (SC-001)

1. Deploy a fresh preview cluster:
   ```bash
   npx generacy launch --claim=<claim-code>
   ```
2. Wait for `cluster.state === 'ready'` in the cloud dashboard.
3. Click **"Connect with VS Code Desktop"**.
4. Expected: device code + `github.com/login/device` URL appears in the UI within ~15 s.
5. Enter the code; expected: UI transitions to a connected tunnel state.

Repeat 10 times across freshly deployed clusters — 100 % should succeed.

### Automated tests

From repo root:

```bash
# Retained-event unit tests
pnpm --filter @generacy-ai/orchestrator test src/__tests__/retained-tunnel-event.test.ts
pnpm --filter @generacy-ai/orchestrator test src/__tests__/relay-bridge-retained-replay.test.ts
pnpm --filter @generacy-ai/orchestrator test src/routes/__tests__/internal-relay-events.test.ts

# Integration test (SC-002)
pnpm --filter @generacy-ai/orchestrator test src/__tests__/vscode-tunnel-retained-replay.integration.test.ts

# Tunnel-manager unit tests (SC-003, SC-004, SC-005)
pnpm --filter @generacy-ai/control-plane test __tests__/vscode-tunnel-manager.test.ts
```

## Configuration knobs

No new env vars ship in this feature. The two internal-tuning constants are:

| Constant                                | Default | Where to override                                           |
|-----------------------------------------|---------|-------------------------------------------------------------|
| `DEFAULT_DEVICE_CODE_TIMEOUT_MS`        | `30_000` (30 s) — "spawned but never printed a code" | `VsCodeTunnelManagerOptions.deviceCodeTimeoutMs` (constructor arg; test only) |
| `DEFAULT_DEVICE_CODE_AUTH_TIMEOUT_MS`   | `300_000` (5 min) — "user is completing device-code flow" | `VsCodeTunnelManagerOptions.authTimeoutMs` (constructor arg; test only) |

Both live in `packages/control-plane/src/services/vscode-tunnel-manager.ts`. No env-var wiring is added in this feature; operator-facing tuning is not in scope.

## Troubleshooting

### "Starting tunnel…" still hangs after the fix

Check in order:

1. **Orchestrator relay status** — `docker compose logs orchestrator | grep -E '(Relay connected|Cannot send message)'`. If the relay never reaches `connected`, retention doesn't help — that's a relay-transport bug (not this feature).
2. **Control-plane → orchestrator IPC health** — the tunnel status event travels HTTP from control-plane to `POST /internal/relay-events`. Confirm control-plane can reach the orchestrator socket:
   ```bash
   docker compose exec control-plane node -e "console.log(process.env.ORCHESTRATOR_INTERNAL_API_KEY?.length)"
   ```
   Should print a non-zero length. If undefined, the IPC bridge (#594) is broken.
3. **`code tunnel` process alive** — `docker compose exec orchestrator ps -ef | grep 'code tunnel'`. If missing, check `packages/control-plane/src/services/vscode-tunnel-manager.ts` spawn errors.
4. **Retention slot populated but not replayed** — add a log line at `RelayBridge.handleConnected` reading `getRetainedTunnelEvent()`. Should print the retained event; if `null`, the write path never fired (check `/internal/relay-events` for the `!isConnected` branch).

### `error: "Timed out waiting for device-code authorization"` in the cloud UI

The user took >5 min to complete GitHub device-code auth. Click **"Retry"** to restart the tunnel. If it happens repeatedly, either:
- Network path to GitHub device endpoint (`https://github.com/login/device`) is blocked from the user's machine — check outside the cluster.
- The device code prompt is not surfacing to the user (unlikely with this fix; check "Starting tunnel…" hang steps above).

### Post-`unregister()` `error` event mysteriously appearing in the UI

Should not happen with this fix (FR-006). If it does, verify `NON_LIFECYCLE_ERROR_MARKERS` in `retained-tunnel-event.ts` still matches the exact strings emitted at `vscode-tunnel-manager.ts` lines 347, 363, 373, and 436. A rename in one place without updating the other breaks eligibility filtering.

## Related follow-ups (out of scope for this issue)

- **Cloud-side client timeout** in `use-vscode-tunnel.ts` — degrade to actionable error instead of infinite spinner. Track as separate `generacy-cloud` issue per one-issue-per-repo convention.
- **General retained/replay layer** for other `cluster.*` channels — case-by-case, not this feature.
- **Persistence across orchestrator restart** — in-memory only.
