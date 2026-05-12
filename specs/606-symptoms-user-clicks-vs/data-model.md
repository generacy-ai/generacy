# Data Model: vscode-tunnel-manager CONNECTED_PATTERN Fix

**Feature**: #606 | **Date**: 2026-05-12

## Interface Changes

### VsCodeTunnelEvent (modified)

**File**: `packages/control-plane/src/services/vscode-tunnel-manager.ts:11-18`

```typescript
export interface VsCodeTunnelEvent {
  status: VsCodeTunnelStatus;
  deviceCode?: string;
  verificationUri?: string;
  tunnelName?: string;
  tunnelUrl?: string;    // NEW (FR-003): full vscode.dev tunnel URL
  error?: string;
  details?: string;      // Used by FR-002: last 20 stdout lines on unexpected exit
}
```

| Field | Type | When Present | Description |
|-------|------|--------------|-------------|
| `status` | `VsCodeTunnelStatus` | Always | Current tunnel state |
| `deviceCode` | `string` | `authorization_pending` | GitHub device code (e.g., `ABCD-1234`) |
| `verificationUri` | `string` | `authorization_pending` | GitHub device auth URL |
| `tunnelName` | `string` | Most events | Cluster tunnel name |
| `tunnelUrl` | `string` | `connected` | Full `https://vscode.dev/tunnel/<name>/...` URL |
| `error` | `string` | `error` | Human-readable error message |
| `details` | `string` | `error` | Last 20 stdout lines for diagnostics |

### VsCodeTunnelStatus (unchanged)

```typescript
type VsCodeTunnelStatus = 'stopped' | 'starting' | 'authorization_pending' | 'connected' | 'disconnected' | 'error';
```

No changes to the status enum. The `error` status was already defined and used by the spawn error handler and device code timeout.

## Relay Event Shape

Events emitted on `cluster.vscode-tunnel` channel. Wire format unchanged — just new optional fields in the payload object.

### Connected event (modified)

```json
{
  "status": "connected",
  "tunnelName": "my-cluster",
  "tunnelUrl": "https://vscode.dev/tunnel/my-cluster/workspaces"
}
```

### Error event on unexpected exit (new scenario)

```json
{
  "status": "error",
  "error": "code tunnel exited (code 1) before reaching connected state",
  "details": "line1\nline2\n...",
  "tunnelName": "my-cluster"
}
```

## Constants (modified)

```typescript
// Line 40 — primary detection pattern
const CONNECTED_PATTERN = /https:\/\/vscode\.dev\/tunnel\/[\w-]+|is connected|tunnel is ready/i;

// New — URL extraction for tunnelUrl field
const TUNNEL_URL_PATTERN = /(https:\/\/vscode\.dev\/tunnel\/[\w-]+[\w\-/]*)/;
```
