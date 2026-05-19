# Data Model: Dynamic /state Endpoint

## Core Types

### ClusterState (Modified)

The existing `ClusterState` schema in `packages/control-plane/src/schemas.ts` gains one new field:

```typescript
// Existing enums (unchanged)
export const ClusterStatusSchema = z.enum(['bootstrapping', 'ready', 'degraded', 'error']);
export type ClusterStatus = z.infer<typeof ClusterStatusSchema>;

export const DeploymentModeSchema = z.enum(['local', 'cloud']);
export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;

export const ClusterVariantSchema = z.enum(['cluster-base', 'cluster-microservices']);
export type ClusterVariant = z.infer<typeof ClusterVariantSchema>;

// Modified schema — adds statusReason
export const ClusterStateSchema = z.object({
  status: ClusterStatusSchema,
  deploymentMode: DeploymentModeSchema,
  variant: ClusterVariantSchema,
  lastSeen: z.string().datetime(),
  statusReason: z.string().max(200).optional(),  // NEW
});
export type ClusterState = z.infer<typeof ClusterStateSchema>;
```

### StatusUpdate (New)

Request body for `POST /internal/status`:

```typescript
export const StatusUpdateSchema = z.object({
  status: ClusterStatusSchema,
  statusReason: z.string().max(200).optional(),
});
export type StatusUpdate = z.infer<typeof StatusUpdateSchema>;
```

## Validation Rules

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `status` | enum | Yes | `'bootstrapping' \| 'ready' \| 'degraded' \| 'error'` |
| `deploymentMode` | enum | Yes | `'local' \| 'cloud'` |
| `variant` | enum | Yes | `'cluster-base' \| 'cluster-microservices'` |
| `lastSeen` | string | Yes | ISO 8601 datetime |
| `statusReason` | string | No | Max 200 chars; present when status is `degraded` or `error` |

## State Machine Rules

| From | To | Trigger | statusReason |
|------|----|---------|--------------|
| (init) | `bootstrapping` | Server startup | absent |
| `bootstrapping` | `ready` | Orchestrator pushes after relay handshake | absent |
| `bootstrapping` | `error` | Fatal startup failure | e.g. "Master key file missing" |
| `ready` | `degraded` | Relay disconnect | e.g. "Relay disconnected — retrying" |
| `degraded` | `ready` | Relay reconnect | absent |
| `ready` | `error` | Unrecoverable failure | e.g. "Schema migration required" |
| `degraded` | `error` | Unrecoverable failure | e.g. "Config file corrupt" |
| `error` | (none) | Terminal — requires restart | — |

## Environment Variables

| Variable | Maps to | Default | Set by |
|----------|---------|---------|--------|
| `DEPLOYMENT_MODE` | `deploymentMode` | `'local'` | Container entrypoint / cloud provisioning |
| `CLUSTER_VARIANT` | `variant` | `'cluster-base'` | Container entrypoint |

## Response Shapes

### GET /state — Success (200)

```json
{
  "status": "ready",
  "deploymentMode": "cloud",
  "variant": "cluster-base",
  "lastSeen": "2026-04-30T12:00:00.000Z"
}
```

When degraded/error:

```json
{
  "status": "degraded",
  "deploymentMode": "cloud",
  "variant": "cluster-base",
  "lastSeen": "2026-04-30T12:00:00.000Z",
  "statusReason": "Relay disconnected — retrying"
}
```

### POST /internal/status — Request Body

```json
{
  "status": "ready",
  "statusReason": "Relay handshake complete"
}
```

### POST /internal/status — Success (200)

```json
{
  "ok": true
}
```

### POST /internal/status — Validation Error (400)

```json
{
  "error": "Invalid status update",
  "code": "INVALID_REQUEST",
  "details": {
    "errors": ["Invalid enum value. Expected 'bootstrapping' | 'ready' | 'degraded' | 'error'"]
  }
}
```
