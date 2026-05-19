# Data Model: Control-Plane Service

## Core Types

### ActorContext

Extracted from relay-injected headers on every request.

```typescript
interface ActorContext {
  userId?: string;    // x-generacy-actor-user-id
  sessionId?: string; // x-generacy-actor-session-id
}
```

### ServerConfig

```typescript
interface ServerConfig {
  socketPath: string; // Default: /run/generacy-control-plane/control.sock
}
```

## Response Schemas (Zod)

### ClusterState — `GET /state`

```typescript
const ClusterStatusSchema = z.enum(['bootstrapping', 'ready', 'degraded', 'error']);
const DeploymentModeSchema = z.enum(['local', 'cloud']);
const ClusterVariantSchema = z.enum(['cluster-base', 'cluster-microservices']);

const ClusterStateSchema = z.object({
  status: ClusterStatusSchema,
  deploymentMode: DeploymentModeSchema,
  variant: ClusterVariantSchema,
  lastSeen: z.string().datetime(),
});

type ClusterState = z.infer<typeof ClusterStateSchema>;
```

Stub returns:
```json
{
  "status": "ready",
  "deploymentMode": "local",
  "variant": "cluster-base",
  "lastSeen": "2026-04-28T12:00:00.000Z"
}
```

### Credential — `GET /credentials/:id`

Re-exported from `@generacy-ai/credhelper`:

```typescript
// From packages/credhelper/src/schemas/credentials.ts
const CredentialEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  backend: z.string(),
  backendKey: z.string(),
  mint: MintConfigSchema.optional(),
});
```

Stub GET response shape wraps the entry with runtime status:
```typescript
const CredentialStubResponseSchema = z.object({
  id: z.string(),
  type: z.string(),
  backend: z.string(),
  backendKey: z.string(),
  status: z.enum(['active', 'pending', 'error']),
  createdAt: z.string().datetime(),
});
```

### Role — `GET /roles/:id`

Re-exported from `@generacy-ai/credhelper`:

```typescript
// From packages/credhelper/src/schemas/roles.ts
const RoleConfigSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  extends: z.string().optional(),
  credentials: z.array(RoleCredentialRefSchema),
  proxy: ProxyConfigSchema.optional(),
  docker: DockerConfigSchema.optional(),
});
```

### Lifecycle — `POST /lifecycle/:action`

```typescript
const LifecycleActionSchema = z.enum([
  'clone-peer-repos',
  'code-server-start',
  'code-server-stop',
]);

const LifecycleRequestSchema = z.object({
  action: LifecycleActionSchema,
});

const LifecycleResponseSchema = z.object({
  accepted: z.literal(true),
  action: LifecycleActionSchema,
});

type LifecycleAction = z.infer<typeof LifecycleActionSchema>;
type LifecycleResponse = z.infer<typeof LifecycleResponseSchema>;
```

Stub returns:
```json
{ "accepted": true, "action": "clone-peer-repos" }
```

### Error Response

```typescript
const ErrorResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
  details: z.unknown().optional(),
});

type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
```

## Error Codes

```typescript
type ControlPlaneErrorCode =
  | 'INVALID_REQUEST'    // 400 — malformed body, missing fields
  | 'NOT_FOUND'          // 404 — unknown route or resource ID
  | 'UNKNOWN_ACTION'     // 400 — lifecycle action not in enum
  | 'SERVICE_UNAVAILABLE'// 503 — service degraded or starting up
  | 'INTERNAL_ERROR';    // 500 — unexpected error

const HTTP_STATUS_MAP: Record<ControlPlaneErrorCode, number> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  UNKNOWN_ACTION: 400,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};
```

## Error Class

```typescript
class ControlPlaneError extends Error {
  readonly code: ControlPlaneErrorCode;
  readonly details?: Record<string, unknown>;

  get httpStatus(): number;
  toResponse(): ErrorResponse;
}

function sendError(res: ServerResponse, error: ControlPlaneError): void;
```

## Route Summary

| Method | Path | Request Body | Response | Error Codes |
|--------|------|-------------|----------|-------------|
| GET | `/state` | — | `ClusterState` | `INTERNAL_ERROR` |
| GET | `/credentials/:id` | — | `CredentialStubResponse` | `NOT_FOUND` |
| PUT | `/credentials/:id` | Credential entry | `{ ok: true }` | `INVALID_REQUEST`, `NOT_FOUND` |
| GET | `/roles/:id` | — | `RoleConfig` | `NOT_FOUND` |
| PUT | `/roles/:id` | Role config | `{ ok: true }` | `INVALID_REQUEST`, `NOT_FOUND` |
| POST | `/lifecycle/:action` | — | `LifecycleResponse` | `UNKNOWN_ACTION` |
| * | `*` | — | — | `NOT_FOUND` |

## Relationships

```
ActorContext ──extracted-from──> HTTP Request Headers
     │
     └──injected-into──> All Route Handlers

ClusterState ──returned-by──> GET /state

CredentialEntry (from @generacy-ai/credhelper)
     │
     └──stub-for──> GET/PUT /credentials/:id

RoleConfig (from @generacy-ai/credhelper)
     │
     └──stub-for──> GET/PUT /roles/:id

LifecycleAction ──validated-by──> Zod enum
     │
     └──acknowledged-by──> POST /lifecycle/:action
```
