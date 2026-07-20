# Contract: `GET /health` response — `postActivationReady`

## Scope

Adds one optional boolean field to the `HealthResponse` schema at `packages/orchestrator/src/types/api.ts` and the corresponding Fastify response schemas at `packages/orchestrator/src/routes/health.ts`.

## Field

| Name | Type | Optional | Meaning |
|---|---|---|---|
| `postActivationReady` | `boolean` | Yes | `true` if the cluster has settled after the post-activation self-restart (or was never going to restart, i.e. non-activated local cluster). `false` if the cluster is currently in the pre-restart window and starting a VS Code tunnel would race the restart. |

## Zod schema

```ts
// packages/orchestrator/src/types/api.ts
export const HealthResponseSchema = z.object({
  status: HealthStatusSchema,
  timestamp: z.string().datetime(),
  services: z.record(ServiceStatusSchema),
  version: z.string(),
  codeServerReady: z.boolean().optional(),
  controlPlaneReady: z.boolean().optional(),
  postActivationReady: z.boolean().optional(),   // NEW
  displayName: z.string().optional(),
  clusterId: z.string().optional(),
  githubAuth: GitHubAuthSnapshotSchema.optional(),
  smeeConfigured: z.boolean().optional(),
});
```

## Fastify response schema

Add to both 200 and 503 response schemas at `packages/orchestrator/src/routes/health.ts:76-113`:

```ts
postActivationReady: { type: 'boolean' },
```

## Producer

`packages/orchestrator/src/routes/health.ts` `GET /health` handler (~L116) — after the existing `Promise.all([probeCodeServerSocket(), probeControlPlaneSocket()])`:

```ts
const postActivationReady = isPostActivationSettledSync();
// ...
const response: HealthResponse = {
  // ... existing fields ...
  codeServerReady,
  controlPlaneReady,
  postActivationReady,   // NEW
};
```

`isPostActivationSettledSync` is imported from `packages/orchestrator/src/services/post-activation-settled-probe.ts` (new module).

## Consumer

- `packages/cluster-relay/src/metadata.ts` `fetchHealth()` reads `data['postActivationReady'] === true` and passes it through to `ClusterMetadata.postActivationReady`.
- Cloud-side consumer reads `postActivationReady` from the cluster metadata forwarded on the relay. Companion cloud PR uses this to gate the "Connect with VS Code Desktop" button (FR-006).

## Backwards compatibility

- Optional field — absence means "orchestrator does not surface the bit." Consumers must not assume `false` when the field is absent (matches `codeServerReady` / `controlPlaneReady` conventions).
- Older orchestrators serving `/health` will simply not include the field. Newer cloud reads it as `undefined` and should default the UI to "enabled" (matching pre-fix behavior — the fix is a UI-side additional gate on the presence of `true`).

## Examples

Wizard cluster, pre-restart:
```json
{
  "status": "ok",
  "timestamp": "2026-07-20T15:53:19.000Z",
  "services": { "server": "ok" },
  "version": "1.5.0",
  "codeServerReady": false,
  "controlPlaneReady": true,
  "postActivationReady": false
}
```

Wizard cluster, post-restart:
```json
{
  "status": "ok",
  "timestamp": "2026-07-20T15:54:00.000Z",
  "services": { "server": "ok" },
  "version": "1.5.0",
  "codeServerReady": true,
  "controlPlaneReady": true,
  "postActivationReady": true
}
```

Local (`generacy launch`) cluster, immediately after boot:
```json
{
  "status": "ok",
  "timestamp": "2026-07-20T14:00:00.000Z",
  "services": { "server": "ok" },
  "version": "1.5.0",
  "codeServerReady": true,
  "controlPlaneReady": true,
  "postActivationReady": true
}
```
