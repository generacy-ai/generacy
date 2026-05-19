# Quickstart: VS Code Tunnel Lifecycle

## Prerequisites

- `code` CLI installed in cluster-base image (companion issue)
- Control-plane running with relay event infrastructure wired

## Lifecycle Actions

### Start tunnel

```bash
# Via relay API (from cloud):
POST /control-plane/lifecycle/vscode-tunnel-start

# Response:
{ "status": "starting", "tunnelName": "<clusterId>" }
```

After start, the control-plane emits relay events on `cluster.vscode-tunnel`:

1. `{ status: 'starting' }` — process spawned
2. `{ status: 'authorization_pending', deviceCode: 'XXXX-XXXX', verificationUri: 'https://github.com/login/device' }` — user must authenticate
3. `{ status: 'connected', tunnelName: '<clusterId>' }` — tunnel ready

### Stop tunnel

```bash
POST /control-plane/lifecycle/vscode-tunnel-stop

# Response:
{ "accepted": true, "action": "vscode-tunnel-stop" }
```

## Auto-start

The tunnel starts automatically after `bootstrap-complete` lifecycle action. No manual start needed during normal bootstrap flow.

## Volume Persistence

The `vscode-cli` named volume persists `~/.vscode-cli/` across container recreation. After initial GitHub device code authentication, subsequent `generacy update` (which runs `docker compose down && up`) will reconnect the tunnel without re-prompting for auth.

## Error Handling

If device code parsing fails (30s timeout):

```json
{
  "status": "error",
  "error": "Device code not detected within timeout",
  "details": "<last 20 lines of stdout>"
}
```

The `details` field contains raw stdout so the user can manually find the device code and complete authentication at `https://github.com/login/device`.

## Testing

```bash
# Run control-plane tests
cd packages/control-plane
pnpm test

# Run scaffolder tests
cd packages/generacy
pnpm test -- src/cli/commands/cluster/__tests__/scaffolder.test.ts
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `code: command not found` | `code` CLI not in image | Wait for cluster-base companion issue |
| Tunnel binds to host | User ran `code tunnel` locally | Use lifecycle action instead — tunnel runs inside cluster |
| Re-auth after update | `vscode-cli` volume missing | Ensure scaffolder includes the volume |
| No relay events | `setRelayPushEvent` not wired | Check orchestrator relay bridge initialization |
