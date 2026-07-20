# Data Model

Zero new persistent entities. One new derived boolean, two schema deltas, one response shape.

## Derived value: `postActivationReady`

**Type**: `boolean`

**Predicate** (identical on orchestrator and control-plane):

```ts
function isPostActivationSettledSync(paths?: {
  keyFilePath?: string;   // default: '/var/lib/generacy/cluster-api-key'
  markerPath?: string;    // default: '/var/lib/generacy/post-activation-restart-done'
}): boolean {
  const key = paths?.keyFilePath ?? '/var/lib/generacy/cluster-api-key';
  const marker = paths?.markerPath ?? '/var/lib/generacy/post-activation-restart-done';
  const activated = existsSync(key);
  const markerPresent = existsSync(marker);
  return !activated || markerPresent;
}
```

**Truth table** (see research.md):

| activated | markerPresent | postActivationReady |
|:---:|:---:|:---:|
| false | false | **true** |
| false | true  | **true** |
| true  | false | **false** |
| true  | true  | **true** |

**Sources of truth**:
- `keyFilePath` written by the orchestrator's activation client on successful device-flow completion.
- `markerPath` written by the cluster-image `entrypoint-post-activation.sh` immediately before `docker restart "$self_container"`.

Neither path is written or deleted by any code in this repository. This feature is read-only over these files.

**Not persisted**: `postActivationReady` is derived on demand — no cache, no in-memory shadow copy. The `PostActivationSettledMonitor` holds no state beyond the watcher registration.

---

## Schema delta: `HealthResponse.postActivationReady`

**Location**: `packages/orchestrator/src/types/api.ts` — `HealthResponseSchema`.

**Change**: Add one field, optional (parity with the existing `codeServerReady` / `controlPlaneReady`).

```ts
export const HealthResponseSchema = z.object({
  // ... existing fields ...
  codeServerReady: z.boolean().optional(),
  controlPlaneReady: z.boolean().optional(),
  postActivationReady: z.boolean().optional(),   // NEW
  // ... rest ...
});
```

**Fastify response schemas** in `packages/orchestrator/src/routes/health.ts` also gain `postActivationReady: { type: 'boolean' }` in both the 200 and 503 response schemas (mirrors `codeServerReady` / `controlPlaneReady` at lines 87-88 / 105-106).

**Validation rules**:
- Optional. Absence means "orchestrator did not surface the bit" (older client-side consumer must not assume `false`).
- When present, `true` = safe to start VS Code tunnel; `false` = cluster is in the pre-restart window.

**Backwards compatibility**:
- Existing consumers that don't know about the field ignore it (Zod `.optional()` + Fastify JSON schema is permissive of unknown fields on responses).
- Existing consumers that check `codeServerReady` / `controlPlaneReady` are unaffected.

---

## Schema delta: `ClusterMetadataPayload.postActivationReady`

**Location**: `packages/orchestrator/src/types/relay.ts` — `ClusterMetadataPayload` interface.

**Change**: Add one optional field.

```ts
export interface ClusterMetadataPayload {
  // ... existing fields ...
  codeServerReady?: boolean;
  controlPlaneReady?: boolean;
  postActivationReady?: boolean;   // NEW
  // ... rest ...
}
```

**Companion**: `packages/cluster-relay/src/messages.ts` — `ClusterMetadata` interface. Same addition.

```ts
export interface ClusterMetadata {
  // ... existing fields ...
  codeServerReady?: boolean;
  controlPlaneReady?: boolean;
  postActivationReady?: boolean;   // NEW
}
```

**Companion**: `packages/cluster-relay/src/metadata.ts` — `HealthData` interface + `fetchHealth` + `collectMetadata` gain the field (mirror of `codeServerReady`).

**Validation rules**: Same as `HealthResponse.postActivationReady`.

**Cross-repo contract**: The `postActivationReady` field name is a wire contract with `generacy-cloud`. Companion cloud-side change is required for FR-006 (UI gating) but not for FR-005 (server-side skip, which works standalone).

---

## Response shape: `LifecycleSkipResponse`

Not an exported type — a response body shape returned by `POST /lifecycle/vscode-tunnel-start` when `postActivationReady === false`.

**Shape**:

```json
{
  "accepted": false,
  "action": "vscode-tunnel-start",
  "deferred": false,
  "reason": "post-activation-not-settled",
  "message": "Cluster is still starting up; retry once postActivationReady is true"
}
```

**Fields**:
- `accepted`: `false` — the request was received and validated, but not enacted. Distinguishes from `accepted: true` responses elsewhere in the handler.
- `action`: `"vscode-tunnel-start"` — echoes the requested action per existing lifecycle-response convention.
- `deferred`: `false` — explicit signal that no server-side watcher/queue was installed. Prevents callers from expecting a later fire.
- `reason`: `"post-activation-not-settled"` — machine-readable code the UI can key off.
- `message`: Human-readable string. Cloud/UI may display or ignore.

**HTTP status**: 200 OK. No new error code (no CONFLICT variant on `ControlPlaneError`).

**Contract-parity note**: `bootstrap-complete` when `postActivationReady === false` continues to return today's 200 body (`{ accepted: true, action: 'bootstrap-complete', sentinel }`). The step (d) skip is a server-internal decision and does not surface in the response — observability is via the existing log line and the `postActivationReady` metadata bit.

---

## Relationships

```
       (cluster-image writes)                       (cluster-image writes)
              │                                            │
              ▼                                            ▼
   /var/lib/generacy/cluster-api-key      /var/lib/generacy/post-activation-restart-done
              │                                            │
              └────────────────┬───────────────────────────┘
                               │  read by
                               ▼
              isPostActivationSettledSync()  (orchestrator + control-plane)
                               │
        ┌──────────────────────┼──────────────────────────┐
        ▼                      ▼                          ▼
  /health response      collectMetadata()          lifecycle handlers
  { postActivation-     { postActivation-          - bootstrap-complete: gate step (d)
    Ready }               Ready }                   - vscode-tunnel-start: skip if false
        │                      │
        └──────► cloud ◄───────┘
                 │
                 ▼
         UI hides tunnel button until true (companion cloud PR)
```

`PostActivationSettledMonitor` (orchestrator, at boot):

```
boot
 │
 ├─ isPostActivationSettledSync() === true  ─────► no-op, no watcher
 │
 └─ isPostActivationSettledSync() === false
       │
       └─ fs.watch(dirname(markerPath))
              │
              └─ event: marker basename created
                     │
                     └─ isPostActivationSettledSync() === true (guard against transient events)
                            │
                            └─ onSettled callback ─► relayBridge.sendMetadata()
                                   │
                                   └─ watcher.close()
```
