# Contract: `ClusterMetadataPayload` / `ClusterMetadata` — `postActivationReady`

## Scope

Adds one optional boolean field to two parallel wire-shape interfaces:

1. `packages/orchestrator/src/types/relay.ts` — `ClusterMetadataPayload` (used when the orchestrator itself is the metadata sender via `RelayBridge`).
2. `packages/cluster-relay/src/messages.ts` — `ClusterMetadata` (used when the `@generacy-ai/cluster-relay` client synthesises metadata from `/health`).

Both must add the field to preserve wire-shape parity across the two paths (matches how `codeServerReady` and `controlPlaneReady` are dual-declared today).

## Field

| Name | Type | Optional | Meaning |
|---|---|---|---|
| `postActivationReady` | `boolean` | Yes | See `health-response.md`. Same semantics on the wire. |

## Orchestrator interface

```ts
// packages/orchestrator/src/types/relay.ts
export interface ClusterMetadataPayload {
  // ... existing fields ...
  codeServerReady?: boolean;
  controlPlaneReady?: boolean;
  postActivationReady?: boolean;   // NEW
  initResult?: { /* ... */ };
  displayName?: string;
  clusterId?: string;
}
```

## Cluster-relay interface

```ts
// packages/cluster-relay/src/messages.ts
export interface ClusterMetadata {
  // ... existing fields ...
  codeServerReady?: boolean;
  controlPlaneReady?: boolean;
  postActivationReady?: boolean;   // NEW
}
```

## Producers

**Orchestrator path** (primary — wizard clusters use this):

`packages/orchestrator/src/services/relay-bridge.ts` `collectMetadata()` (~L706):

```ts
async collectMetadata(): Promise<ClusterMetadataPayload> {
  const [codeServerReady, controlPlaneReady] = await Promise.all([
    probeCodeServerSocket(),
    probeControlPlaneSocket(),
  ]);
  const postActivationReady = isPostActivationSettledSync();   // NEW

  const metadata: ClusterMetadataPayload = {
    // ... existing fields ...
    codeServerReady,
    controlPlaneReady,
    postActivationReady,   // NEW
  };
  // ... rest unchanged ...
}
```

**Cluster-relay path** (secondary — synthesises from `/health` for callers that don't have a RelayBridge):

`packages/cluster-relay/src/metadata.ts` `fetchHealth()` — mirror the `codeServerReady` read at lines 61-62:

```ts
const result: HealthData = {
  version: String(data['version'] ?? '0.0.0'),
  channel: (data['channel'] === 'preview' ? 'preview' : 'stable'),
  uptime: Number(data['uptime'] ?? 0),
  codeServerReady: data['codeServerReady'] === true,
  controlPlaneReady: data['controlPlaneReady'] === true,
  postActivationReady: data['postActivationReady'] === true,   // NEW
};
```

`collectMetadata()` in the same file — mirror the `codeServerReady` copy:

```ts
const metadata: ClusterMetadata = {
  // ... existing ...
  codeServerReady: health.codeServerReady,
  controlPlaneReady: health.controlPlaneReady,
  postActivationReady: health.postActivationReady,   // NEW
};
```

## Consumer

Cloud-side (companion `generacy-cloud` PR) reads `metadata.postActivationReady` and:
- Hides or disables the "Connect with VS Code Desktop" button while `postActivationReady === false || postActivationReady === undefined`.
  - `=== undefined` guarantees older orchestrators that don't surface the bit still get the safety of the gate. (This is stricter than `/health`'s consumer contract; the metadata surface is user-facing UI and defaults conservative.)
- Re-enables the button on the first metadata payload with `postActivationReady === true`.

## Push-latency requirement (FR-003)

Additional to periodic 60s metadata heartbeat, an immediate `sendMetadata()` fires when the marker file appears at `/var/lib/generacy/post-activation-restart-done`. This is driven by `PostActivationSettledMonitor` (new orchestrator module) installing a one-shot `fs.watch` at boot when the marker is absent. Target latency: ≤5s p95 from marker-write to cloud-received (SC-002 — same target as `codeServerReady` post-#586/#596).

## Field-name rationale (Q3)

`postActivationReady` chosen over `postActivationSettled` (Q3/A) and `postActivationRestartDone` (Q3/B) for parallel construction with `codeServerReady` / `controlPlaneReady`. Deliberately decoupled from the marker filename (`post-activation-restart-done`) so a future change to the marker's write mechanism (Q5/D → Q5/B pivot) does not require a wire-schema change.
