# Data Model: Control-plane 401 Guard

## Modified Types

### ControlPlaneErrorCode (extended)

```typescript
export type ControlPlaneErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'UNKNOWN_ACTION'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'UNAUTHORIZED';  // ← NEW
```

### HTTP_STATUS_MAP (extended)

```typescript
const HTTP_STATUS_MAP: Record<ControlPlaneErrorCode, number> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  UNKNOWN_ACTION: 400,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
  UNAUTHORIZED: 401,  // ← NEW
};
```

## New Functions

### requireActor (context.ts)

```typescript
export function requireActor(actor: ActorContext): void
```

**Input**: `ActorContext` (existing interface, unchanged)
**Behavior**: Throws `ControlPlaneError('UNAUTHORIZED', 'Missing actor identity')` when `actor.userId` is falsy.
**Output**: void (assertion function)

## Existing Types (unchanged)

### ActorContext

```typescript
export interface ActorContext {
  userId?: string;
  sessionId?: string;
}
```

### ControlPlaneErrorResponse

```typescript
export interface ControlPlaneErrorResponse {
  error: string;
  code: ControlPlaneErrorCode;
  details?: Record<string, unknown>;
}
```

## Error Response Examples

### 401 Unauthorized (new)

```json
{
  "error": "Missing actor identity",
  "code": "UNAUTHORIZED"
}
```

HTTP Status: 401

## Route Guard Matrix

| Route | Method | Guard | Reason |
|-------|--------|-------|--------|
| `/state` | GET | None | Diagnostic/health-check |
| `/credentials/:id` | GET | None | Diagnostic read |
| `/credentials/:id` | PUT | `requireActor` | State mutation |
| `/roles/:id` | GET | None | Diagnostic read |
| `/roles/:id` | PUT | `requireActor` | State mutation |
| `/lifecycle/:action` | POST | `requireActor` | State mutation |
| `/internal/audit-batch` | POST | None | In-cluster service call |
| `/internal/status` | POST | None | In-cluster service call |
