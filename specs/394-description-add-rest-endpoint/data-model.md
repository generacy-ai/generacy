# Data Model: Sessions REST Endpoint

## Core Entities

### SessionMetadata

Represents parsed metadata from a single Claude Code session JSONL file.

```typescript
const SessionTypeSchema = z.enum(['automated', 'developer']);

const SessionMetadataSchema = z.object({
  /** Session UUID (from filename) */
  sessionId: z.string().uuid(),
  /** Human-readable session name (from slug field) */
  slug: z.string().nullable(),
  /** Session start time (first message timestamp) */
  startedAt: z.string().datetime(),
  /** Last activity time (last message timestamp) */
  lastActivityAt: z.string().datetime(),
  /** Count of user + assistant messages */
  messageCount: z.number().int().nonnegative(),
  /** Claude model used (from first assistant message) */
  model: z.string().nullable(),
  /** Git branch active during session */
  gitBranch: z.string().nullable(),
  /** Session type: automated (orchestrator) or developer (VS Code/CLI) */
  type: SessionTypeSchema,
  /** Workspace directory path (decoded from session directory name) */
  workspace: z.string().nullable(),
});
```

### SessionListResponse

Paginated response envelope matching existing API conventions.

```typescript
const SessionListResponseSchema = z.object({
  sessions: z.array(SessionMetadataSchema),
  pagination: PaginationSchema,  // reuses existing PaginationSchema
});
```

### ListSessionsQuery

Query parameters for the list endpoint.

```typescript
const ListSessionsQuerySchema = z.object({
  /** Filter by workspace identifier or path */
  workspace: z.string().optional(),
  /** Page number (1-based) */
  page: z.coerce.number().int().positive().default(1),
  /** Items per page */
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
```

## Type Definitions

### Internal (service layer)

```typescript
/** Raw parsed data from a single JSONL line */
interface ParsedLine {
  type: string;
  timestamp?: string;
  sessionId?: string;
  slug?: string;
  gitBranch?: string;
  userType?: string;
  permissionMode?: string;
  message?: {
    model?: string;
    role?: string;
    usage?: Record<string, unknown>;
  };
}

/** Accumulator used during JSONL streaming */
interface SessionAccumulator {
  sessionId: string;
  slug: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  messageCount: number;
  model: string | null;
  gitBranch: string | null;
  permissionMode: string | null;
  workspace: string | null;
}
```

## Validation Rules

| Field | Validation | Default |
|-------|-----------|---------|
| `sessionId` | UUID format (from filename) | Required |
| `slug` | String or null | `null` if no slug found in messages |
| `startedAt` | ISO 8601 datetime | First timestamp in file |
| `lastActivityAt` | ISO 8601 datetime | Last timestamp in file |
| `messageCount` | Non-negative integer | 0 if no user/assistant messages |
| `model` | String or null | `null` if no assistant messages |
| `gitBranch` | String or null | `null` if not present |
| `type` | `"automated"` or `"developer"` | `"developer"` (default) |
| `workspace` | Decoded path or null | `null` if cannot decode |
| `page` | Positive integer | 1 |
| `pageSize` | Integer 1-100 | 20 |

## Relationships

```
~/.claude/projects/
  └── {encoded-workspace-dir}/     ← maps to workspace path
       └── {sessionId}.jsonl       ← one file per session
            ├── queue-operation lines
            ├── user lines          ← slug, gitBranch, permissionMode
            ├── assistant lines     ← message.model
            └── last-prompt line
```

- **Workspace → Sessions**: one-to-many (a workspace directory contains many session files)
- **Session → Messages**: one-to-many (a JSONL file contains many message lines)
- **Config workspace ↔ Directory**: configured workspaces map to directories via path encoding (`/` → `-`)
