# Data Model: bootstrap-complete lifecycle action

**Feature**: #562 | **Date**: 2026-05-10

## Schema Changes

### LifecycleActionSchema (modified)

**File**: `packages/control-plane/src/schemas.ts`

```typescript
// Before (5 values)
export const LifecycleActionSchema = z.enum([
  'clone-peer-repos',
  'set-default-role',
  'code-server-start',
  'code-server-stop',
  'stop',
]);

// After (6 values)
export const LifecycleActionSchema = z.enum([
  'bootstrap-complete',   // NEW
  'clone-peer-repos',
  'set-default-role',
  'code-server-start',
  'code-server-stop',
  'stop',
]);
```

**Type**: `z.infer<typeof LifecycleActionSchema>` becomes:
```typescript
'bootstrap-complete' | 'clone-peer-repos' | 'set-default-role' | 'code-server-start' | 'code-server-stop' | 'stop'
```

### Response Shape

No new schema needed. The handler returns a superset of `LifecycleResponseSchema`:

```typescript
// Existing schema (unchanged)
export const LifecycleResponseSchema = z.object({
  accepted: z.literal(true),
  action: z.string(),
});

// Actual response includes extra `sentinel` field (forward-compatible)
{
  accepted: true,
  action: 'bootstrap-complete',
  sentinel: '/tmp/generacy-bootstrap-complete'  // extra, not schema-enforced
}
```

The `sentinel` field is informational and not validated by consumers. The existing `LifecycleResponseSchema` uses `z.object()` (not `.strict()`), so extra fields pass validation.

### Request Shape

No request body. The action is conveyed via URL path parameter: `POST /lifecycle/bootstrap-complete`.

## Entities

### Sentinel File

| Property | Value |
|----------|-------|
| Path | `$POST_ACTIVATION_TRIGGER` or `/tmp/generacy-bootstrap-complete` |
| Content | Empty string |
| Permissions | Container umask (typically 0644) |
| Created by | Control-plane handler |
| Consumed by | `post-activation-watcher.sh` (inotifywait) |
| Lifecycle | Written once, never deleted by control-plane |

## Validation Rules

| Rule | Enforcement |
|------|-------------|
| Action must be valid enum value | `LifecycleActionSchema.safeParse()` — returns `UNKNOWN_ACTION` error if invalid |
| Actor must have userId | `requireActor(actor)` — returns 401 if missing |
| File write must succeed | `writeFile()` throws on filesystem error — caught by server error handler |
