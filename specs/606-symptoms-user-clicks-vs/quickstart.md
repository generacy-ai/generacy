# Quickstart: Testing #606 vscode-tunnel-manager Fix

## Prerequisites

- Running Generacy cluster (local or remote)
- GitHub account for device authorization
- `code` CLI 1.95.3 installed in cluster image

## Manual Test: Full Flow (SC-001)

1. Start a fresh cluster bootstrap
2. Complete the wizard through to the "VS Code Tunnel" step
3. The tunnel dialog should show "Waiting for authorization..." with a device code
4. Open `https://github.com/login/device` and enter the device code
5. After authorization, the dialog should transition to "Open in VS Code Desktop" within ~2s
6. Verify the `connected` event includes a `tunnelUrl` field

## Manual Test: Unexpected Exit (SC-002)

1. Start a cluster and trigger VS Code tunnel start
2. Before authorizing, kill the `code tunnel` process inside the container:
   ```bash
   docker exec <container> pkill -f "code tunnel"
   ```
3. The dialog should show an error message (not stay on "Waiting for authorization...")
4. Check relay events for an `error` event with `details` containing recent stdout

## Unit Test Pattern

Feed the manager synthetic stdout matching `code` CLI 1.95.3 output:

```typescript
const transcript = [
  '* Visual Studio Code Server',
  '*',
  '* By using the software, you agree to',
  '* the Visual Studio Code Server License Terms (https://aka.ms/vscode-server-license) and',
  '* the Microsoft Privacy Statement (https://privacy.microsoft.com/en-us/privacystatement).',
  '*',
  'To grant access to the server, please log into https://github.com/login/device and use code ABCD-1234',
  'Open this link in your browser https://vscode.dev/tunnel/test-cluster/workspaces',
];
```

Assert:
- After line 7: status transitions to `authorization_pending`, device code is `ABCD-1234`
- After line 8: status transitions to `connected`, `tunnelUrl` is `https://vscode.dev/tunnel/test-cluster/workspaces`

## Verification Checklist

- [ ] `CONNECTED_PATTERN` matches `https://vscode.dev/tunnel/<name>/` URL
- [ ] `CONNECTED_PATTERN` still matches legacy `is connected` / `tunnel is ready` strings
- [ ] `connected` event includes `tunnelUrl` field when URL is present
- [ ] `error` event emitted on exit during `starting` state
- [ ] `error` event emitted on exit during `authorization_pending` state
- [ ] `error` event includes exit code and last 20 stdout lines
- [ ] Existing `disconnected` event on exit from `connected` state still works
- [ ] Device code timeout still works for `starting` state
