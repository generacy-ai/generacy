# Data Model: Remove Role Selection from Bootstrap Wizard

**Feature**: #582 | **Date**: 2026-05-11

## Schema Changes

This feature is a pure deletion. The only schema change is narrowing existing Zod types.

### LifecycleActionSchema (before)

```typescript
export const LifecycleActionSchema = z.enum([
  'bootstrap-complete',
  'clone-peer-repos',
  'set-default-role',    // REMOVE
  'code-server-start',
  'code-server-stop',
  'stop',
]);
```

### LifecycleActionSchema (after)

```typescript
export const LifecycleActionSchema = z.enum([
  'bootstrap-complete',
  'clone-peer-repos',
  'code-server-start',
  'code-server-stop',
  'stop',
]);
```

Enum narrows from 6 to 5 entries.

### Deleted Schemas

```typescript
// DELETED — was in schemas.ts
export const SetDefaultRoleBodySchema = z.object({
  role: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
});
export type SetDefaultRoleBody = z.infer<typeof SetDefaultRoleBodySchema>;
```

### Deleted Re-exports

```typescript
// DELETED — was in index.ts
export { SetDefaultRoleBodySchema } from './schemas.js';
export type { SetDefaultRoleBody } from './schemas.js';
```

## Routes Removed

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| GET | `/roles/:id` | `handleGetRole` | Stub that returned role data |
| PUT | `/roles/:id` | `handlePutRole` | Set cluster default role |

## Services Removed

| Service | Function | Purpose |
|---------|----------|---------|
| `default-role-writer.ts` | `setDefaultRole()` | Write `defaults.role` to `.generacy/config.yaml` |

## Entities Unchanged

- `ClusterState` (from `GET /state`) — no role field
- `CredentialSchemas` — roles are handled by credhelper-daemon, unaffected
- All other lifecycle actions — unaffected
