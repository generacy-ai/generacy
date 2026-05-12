# Data Model: VS Code tunnel name derivation

**Feature**: #608 | **Date**: 2026-05-12

## New Exports

### `deriveTunnelName(clusterId: string): string`

**File**: `packages/control-plane/src/services/vscode-tunnel-manager.ts`

Pure function. No side effects. Exported for unit testing.

```typescript
export function deriveTunnelName(clusterId: string): string {
  const compact = clusterId.replace(/-/g, '');
  return `g-${compact.slice(0, 18)}`;
}
```

| Input | Output | Length |
|-------|--------|--------|
| `9e5c8a0d-755e-40b3-b0c3-43e849f0bb90` | `g-9e5c8a0d755e40b3b0` | 20 |
| `abcdef12-3456-7890-abcd-ef1234567890` | `g-abcdef1234567890ab` | 20 |
| `short` | `g-short` | 7 |

### Invariants

- Output length <= 20 for any standard UUID input (36 chars with hyphens → 32 hex → sliced to 18 + 2 prefix = 20)
- Deterministic: same `clusterId` always produces same output
- Idempotent under composition: `deriveTunnelName(deriveTunnelName(x))` is not guaranteed but irrelevant — only called once with raw cluster ID

## Modified Functions

### `loadOptionsFromEnv(env?)` (modified)

**File**: `packages/control-plane/src/services/vscode-tunnel-manager.ts:44-52`

Before: `tunnelName = env['GENERACY_CLUSTER_ID']` (raw)
After: `tunnelName = deriveTunnelName(env['GENERACY_CLUSTER_ID'])` (derived)

Return type `VsCodeTunnelManagerOptions` unchanged. Error behavior unchanged (throws if `GENERACY_CLUSTER_ID` missing).

## Unchanged Interfaces

### `VsCodeTunnelManagerOptions`

```typescript
export interface VsCodeTunnelManagerOptions {
  binPath: string;
  tunnelName: string;       // Now receives derived name instead of raw UUID
  forceKillTimeoutMs?: number;
  deviceCodeTimeoutMs?: number;
}
```

No structural change — `tunnelName` was always a `string`. The semantic change (raw → derived) is transparent to all consumers.

### `VsCodeTunnelEvent`

No changes. The `tunnelName` field in events will contain the derived name (it always reflected `this.opts.tunnelName`).

## Relay Event Impact

Events on `cluster.vscode-tunnel` channel will now include the derived name in `tunnelName`:

```json
{
  "status": "connected",
  "tunnelName": "g-9e5c8a0d755e40b3b0",
  "tunnelUrl": "https://vscode.dev/tunnel/g-9e5c8a0d755e40b3b0/workspaces"
}
```

Cloud consumers that read `tunnelName` from relay events (for deep links) will automatically receive the correct derived name. No cloud-side code change needed for event consumption — only the `VSCodeDesktopDialog.tsx` deep link construction needs updating (companion issue).
