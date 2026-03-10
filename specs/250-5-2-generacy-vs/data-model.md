# Data Models: 5.2 — Generacy VS Code Extension MVP

## New Types

### ProjectConfig

Schema for `.generacy/config.yaml` parsed on activation.

```typescript
import { z } from 'zod';

export const ProjectConfigSchema = z.object({
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  repos: z.object({
    primary: z.string().optional(),
  }).optional(),
}).passthrough(); // Forward-compatible with future fields

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
```

Example `.generacy/config.yaml`:

```yaml
project:
  id: "proj_abc123"
  name: "My Application"
repos:
  primary: "my-org/my-app"
```

### UserProfile

Returned by `GET /users/me` after authentication.

```typescript
export const UserOrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['owner', 'admin', 'member']),
});

export const UserProfileSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  email: z.string().email(),
  avatarUrl: z.string().url().nullable(),
  tier: z.enum(['anonymous', 'free', 'organization']),
  organizations: z.array(UserOrgSchema),
});

export type UserOrg = z.infer<typeof UserOrgSchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;
```

---

## Modified Types

### QueueStatus

```typescript
// Before:
export type QueueStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// After:
export type QueueStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
```

### QueueItem

```typescript
// Added field:
export interface QueueItem {
  // ... existing fields ...

  /** What the job is waiting for (only present when status === 'waiting') */
  waitingFor?: string;
}
```

Zod schema update:

```typescript
export const QueueItemSchema = z.object({
  // ... existing fields ...
  status: z.enum(['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled']),
  waitingFor: z.string().optional(),
});
```

### QueueStats (webview)

```typescript
// Before:
export interface QueueStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
}

// After:
export interface QueueStats {
  pending: number;
  running: number;
  waiting: number;
  completed: number;
  failed: number;
}
```

### User

```typescript
// Added field:
export interface User {
  // ... existing fields ...

  /** Organizations the user belongs to */
  organizations?: UserOrg[];
}
```

---

## SSE Event Types

No new event types are added. The existing event namespace (`workflow:*`, `queue:*`, `agent:*`, `job:*`) is preserved per Q2 clarification.

The `queue:updated` event already carries the full `QueueItem` payload, which will now include the `waiting` status and `waitingFor` field when applicable.

```typescript
// Existing event — now supports waiting status:
// event: queue:updated
// data: { item: QueueItem }  ← QueueItem.status can now be 'waiting'
```
