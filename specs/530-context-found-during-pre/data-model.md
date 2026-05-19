# Data Model: Complete Cluster Control-Plane Lifecycle Handlers

## Schema Extensions

### LifecycleActionSchema (modified)

```typescript
// packages/control-plane/src/schemas.ts
export const LifecycleActionSchema = z.enum([
  'clone-peer-repos',
  'set-default-role',
  'code-server-start',
  'code-server-stop',
  'stop',
]);

export type LifecycleAction = z.infer<typeof LifecycleActionSchema>;
```

### New Request Body Schemas

```typescript
// packages/control-plane/src/schemas.ts

export const ClonePeerReposBodySchema = z.object({
  repos: z.array(z.string().url()).min(0),
  token: z.string().optional(),
});

export type ClonePeerReposBody = z.infer<typeof ClonePeerReposBodySchema>;

export const SetDefaultRoleBodySchema = z.object({
  role: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
});

export type SetDefaultRoleBody = z.infer<typeof SetDefaultRoleBodySchema>;
```

## Relay Event Types

### cluster.bootstrap Channel Events

```typescript
// Emitted per-repo during clone
interface CloneProgressEvent {
  repo: string;       // Full repo URL
  status: 'cloning' | 'done' | 'failed';
  message?: string;   // Error message on 'failed', info on 'done'
}

// Emitted when repos array is empty
interface NoReposEvent {
  status: 'done';
  message: 'no peer repos';
}

type BootstrapEvent = CloneProgressEvent | NoReposEvent;
```

## Service Interfaces

### PeerRepoCloner

```typescript
// packages/control-plane/src/services/peer-repo-cloner.ts

interface CloneResult {
  repo: string;
  status: 'done' | 'failed' | 'skipped';
  message?: string;
}

interface PeerRepoClonerOptions {
  repos: string[];
  token?: string;
  workspacesDir?: string;  // Default: '/workspaces'
}

export async function clonePeerRepos(options: PeerRepoClonerOptions): Promise<CloneResult[]>;
```

### DefaultRoleWriter

```typescript
// packages/control-plane/src/services/default-role-writer.ts

interface SetDefaultRoleOptions {
  role: string;
  agencyDir?: string;   // Default: '.agency' (relative to workspace root)
  configPath?: string;  // Default: '.generacy/config.yaml'
}

export async function setDefaultRole(options: SetDefaultRoleOptions): Promise<void>;
// Throws ControlPlaneError('INVALID_REQUEST') if role file doesn't exist
```

### Relay Push Event (extracted to shared module)

```typescript
// packages/control-plane/src/relay-events.ts

type PushEventFn = (channel: string, data: unknown) => void;

let pushEventFn: PushEventFn | undefined;

export function setRelayPushEvent(fn: PushEventFn): void {
  pushEventFn = fn;
}

export function getRelayPushEvent(): PushEventFn | undefined {
  return pushEventFn;
}
```

## File Formats

### `.generacy/config.yaml` (written by `set-default-role`)

```yaml
defaults:
  role: developer
```

Merge behavior: if file exists with other keys, preserve them. Only set/overwrite `defaults.role`.

### `.agency/roles/<role>.yaml` (read-only validation target)

Existence check only. File content not parsed by this feature.

## Response Schemas

### Lifecycle Response (existing, reused)

```typescript
// Already defined in schemas.ts
export const LifecycleResponseSchema = z.object({
  accepted: z.literal(true),
  action: LifecycleActionSchema,
});
```

Used by: `set-default-role`, `clone-peer-repos`, `stop`

### Error Response (existing)

```typescript
// From errors.ts
interface ControlPlaneErrorResponse {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}
```

Error codes for this feature:
- `INVALID_REQUEST` (400): Invalid body, role doesn't exist
- `UNKNOWN_ACTION` (400): Action not in schema (eliminated by schema fix)

## Validation Rules

| Field | Rule | Error |
|-------|------|-------|
| `repos[]` | Valid URL strings | Zod URL validation |
| `token` | Optional string, no format constraint | — |
| `role` | `^[a-z0-9-]+$`, 1-64 chars | Zod regex + length |
| Role file existence | `fs.access('.agency/roles/<role>.yaml')` | `INVALID_REQUEST` |
| Repo target dir | Must not be an existing file (only check dir) | Skip + emit `done` |

## Relationships

```
Cloud wizard step 3 (Role selection)
  → POST /lifecycle/set-default-role { role }
    → DefaultRoleWriter validates + writes .generacy/config.yaml
    → Returns { accepted: true, action: 'set-default-role' }

Cloud wizard step 4 (Peer repos)
  → POST /lifecycle/clone-peer-repos { repos, token? }
    → PeerRepoCloner iterates repos[]
      → Emits cluster.bootstrap events via relay
    → Returns { accepted: true, action: 'clone-peer-repos' }

Relay events → Cloud SSE consumer → Wizard UI progress updates
```
