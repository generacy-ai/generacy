# Data Model: Workflow Publishing

## Overview

This document defines the core entities, interfaces, and type definitions for the workflow publishing feature.

## Core Entities

### 1. WorkflowVersion

Represents a single published version of a workflow.

```typescript
interface WorkflowVersion {
  /** Incremental version number (1, 2, 3, ...) */
  version: number;

  /** Optional semantic version tag (e.g., "v1.0.0", "v2.1.3") */
  tag?: string;

  /** ISO 8601 timestamp when this version was published */
  publishedAt: string;

  /** User ID of the person who published this version */
  publishedBy: string;

  /** Optional changelog message describing changes */
  changelog?: string;
}
```

**Zod Schema**:
```typescript
export const WorkflowVersionSchema = z.object({
  version: z.number().int().positive(),
  tag: z.string().optional(),
  publishedAt: z.string().datetime(),
  publishedBy: z.string(),
  changelog: z.string().optional(),
});
```

**Validation Rules**:
- `version`: Must be positive integer (1+)
- `tag`: Optional, but if provided should match semver pattern
- `publishedAt`: Must be valid ISO 8601 datetime
- `publishedBy`: Must be non-empty string (user ID)
- `changelog`: Optional, no length restrictions

### 2. PublishedWorkflow

Represents a workflow that has been published to the cloud, including its version history.

```typescript
interface PublishedWorkflow {
  /** Unique workflow identifier (UUID) */
  id: string;

  /** Workflow name (must match filename without .yaml extension) */
  name: string;

  /** Latest version number */
  currentVersion: number;

  /** Complete version history (sorted newest first) */
  versions: WorkflowVersion[];

  /** ISO 8601 timestamp of last successful sync (optional) */
  lastSyncedAt?: string;
}
```

**Zod Schema**:
```typescript
export const PublishedWorkflowSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  currentVersion: z.number().int().positive(),
  versions: z.array(WorkflowVersionSchema),
  lastSyncedAt: z.string().datetime().optional(),
});
```

**Validation Rules**:
- `id`: Must be valid UUID
- `name`: Non-empty string, matches workflow filename
- `currentVersion`: Must equal highest version in `versions` array
- `versions`: Must be sorted descending by version number
- `lastSyncedAt`: Optional, must be valid ISO 8601 datetime

### 3. PublishWorkflowRequest

Request payload for publishing a workflow to the cloud.

```typescript
interface PublishWorkflowRequest {
  /** Workflow name (used for identification) */
  name: string;

  /** Complete YAML content of the workflow */
  content: string;

  /** Optional changelog describing changes in this version */
  changelog?: string;

  /** Optional semantic version tag (e.g., "v1.2.0") */
  tag?: string;
}
```

**Zod Schema**:
```typescript
export const PublishWorkflowRequestSchema = z.object({
  name: z.string().min(1),
  content: z.string().min(1),
  changelog: z.string().optional(),
  tag: z.string().regex(/^v?\d+\.\d+\.\d+/).optional(),
});
```

**Validation Rules**:
- `name`: Non-empty string (workflow filename)
- `content`: Non-empty string (valid YAML)
- `changelog`: Optional, recommended for updates
- `tag`: Optional, must match semver pattern if provided

### 4. PublishWorkflowResponse

Response from the API after successfully publishing a workflow.

```typescript
interface PublishWorkflowResponse {
  /** Workflow ID (UUID) */
  id: string;

  /** New version number assigned */
  version: number;

  /** ISO 8601 timestamp when published */
  publishedAt: string;
}
```

**Zod Schema**:
```typescript
export const PublishWorkflowResponseSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  publishedAt: z.string().datetime(),
});
```

### 5. SyncStatus

Represents the synchronization status of a local workflow file relative to the cloud.

```typescript
type SyncStatus =
  | 'synced'        // Local matches cloud (✓ green)
  | 'ahead'         // Local has unpublished changes (↑ yellow)
  | 'behind'        // Cloud has newer version (↓ blue)
  | 'conflict'      // Both local and cloud changed (⚠ red)
  | 'not-published' // Never published to cloud (⊘ gray)
  | 'unknown';      // Unable to determine status (? gray)

interface WorkflowSyncStatus {
  /** Local workflow name */
  name: string;

  /** Current sync status */
  status: SyncStatus;

  /** Local file modification time (Unix timestamp) */
  localModifiedAt: number;

  /** Cloud version number (if published) */
  cloudVersion?: number;

  /** Cloud version timestamp (if published) */
  cloudPublishedAt?: string;

  /** Cache timestamp (Unix timestamp) */
  cachedAt: number;
}
```

**Status Determination Logic**:
```typescript
function determineSyncStatus(
  localContent: string,
  localModifiedAt: number,
  cloudWorkflow?: PublishedWorkflow
): SyncStatus {
  // Not published to cloud yet
  if (!cloudWorkflow) {
    return 'not-published';
  }

  // Fetch latest cloud version content
  const cloudContent = await getWorkflowVersion(
    cloudWorkflow.name,
    cloudWorkflow.currentVersion
  );

  // Content matches exactly
  if (localContent === cloudContent) {
    return 'synced';
  }

  // Local modified after cloud publish
  const cloudPublishedAt = new Date(
    cloudWorkflow.versions[0].publishedAt
  ).getTime();

  if (localModifiedAt > cloudPublishedAt) {
    return 'ahead'; // Local changes not yet published
  } else {
    return 'behind'; // Cloud has changes not pulled locally
  }
}
```

### 6. VersionComparison

Represents a diff comparison between two workflow versions.

```typescript
interface VersionComparison {
  /** Left side version info */
  left: {
    version: number | 'local';
    content: string;
    timestamp: string;
  };

  /** Right side version info */
  right: {
    version: number | 'local';
    content: string;
    timestamp: string;
  };

  /** Summary of differences */
  summary: {
    addedLines: number;
    removedLines: number;
    changedLines: number;
  };
}
```

## Type Relationships

```
PublishedWorkflow
├── id: string
├── name: string
├── currentVersion: number
├── versions: WorkflowVersion[]
│   └── WorkflowVersion
│       ├── version: number
│       ├── tag?: string
│       ├── publishedAt: string
│       ├── publishedBy: string
│       └── changelog?: string
└── lastSyncedAt?: string

WorkflowSyncStatus
├── name: string
├── status: SyncStatus
├── localModifiedAt: number
├── cloudVersion?: number
├── cloudPublishedAt?: string
└── cachedAt: number
```

## API Request/Response Mappings

### Publish Workflow

**Request**:
```typescript
POST /workflows/publish
Content-Type: application/json

{
  "name": "ci-workflow",
  "content": "name: CI Workflow\nphases: [...] ",
  "changelog": "Added deployment phase",
  "tag": "v1.2.0"
}
```

**Response**:
```typescript
201 Created
Content-Type: application/json

{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "version": 3,
  "publishedAt": "2026-01-22T10:30:00Z"
}
```

### Get Workflow Details

**Request**:
```typescript
GET /workflows/ci-workflow
Authorization: Bearer <token>
```

**Response**:
```typescript
200 OK
Content-Type: application/json

{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "name": "ci-workflow",
  "currentVersion": 3,
  "versions": [
    {
      "version": 3,
      "tag": "v1.2.0",
      "publishedAt": "2026-01-22T10:30:00Z",
      "publishedBy": "user-123",
      "changelog": "Added deployment phase"
    },
    {
      "version": 2,
      "publishedAt": "2026-01-20T15:00:00Z",
      "publishedBy": "user-123",
      "changelog": "Fixed test step"
    },
    {
      "version": 1,
      "publishedAt": "2026-01-18T09:00:00Z",
      "publishedBy": "user-123"
    }
  ],
  "lastSyncedAt": "2026-01-22T10:30:00Z"
}
```

### Get Specific Version Content

**Request**:
```typescript
GET /workflows/ci-workflow/versions/2
Authorization: Bearer <token>
```

**Response**:
```typescript
200 OK
Content-Type: application/json

{
  "content": "name: CI Workflow\nphases:\n  - name: test\n    steps: [...]"
}
```

## Local State Management

### Sync Status Cache

Stored in VS Code workspace state (Memento API):

```typescript
interface SyncStatusCache {
  /** Workflow name -> sync status mapping */
  [workflowName: string]: {
    status: SyncStatus;
    cloudVersion?: number;
    cachedAt: number; // Unix timestamp
  };
}

// Cache key
const CACHE_KEY = 'generacy.workflow.syncStatus';

// Cache TTL (5 minutes)
const CACHE_TTL = 5 * 60 * 1000;
```

**Cache Invalidation Rules**:
1. File save event → invalidate for that workflow
2. Publish success → invalidate for that workflow
3. Rollback success → invalidate for that workflow
4. Cache age > TTL → invalidate and refresh
5. Manual refresh command → invalidate all

### Recent Publish Operations

Stored in global state for telemetry and error recovery:

```typescript
interface RecentPublish {
  workflowName: string;
  version: number;
  publishedAt: string;
  success: boolean;
  error?: string;
}

// Recent publishes (last 10)
const RECENT_PUBLISHES_KEY = 'generacy.workflow.recentPublishes';
```

## Error Response Types

### Validation Error

```typescript
{
  "error": "validation_error",
  "message": "Invalid workflow content",
  "details": {
    "field": "content",
    "issue": "YAML parse error at line 15"
  }
}
```

### Conflict Error

```typescript
{
  "error": "conflict",
  "message": "Cloud version has changed",
  "details": {
    "localVersion": 2,
    "cloudVersion": 3,
    "cloudPublishedAt": "2026-01-22T10:30:00Z"
  }
}
```

### Authentication Error

```typescript
{
  "error": "unauthorized",
  "message": "Authentication required",
  "details": {
    "code": "token_expired"
  }
}
```

## Constants and Enums

```typescript
/** Maximum workflow content size (5 MB) */
export const MAX_WORKFLOW_SIZE = 5 * 1024 * 1024;

/** Sync status cache TTL (5 minutes) */
export const SYNC_STATUS_CACHE_TTL = 5 * 60 * 1000;

/** Maximum recent publishes to track */
export const MAX_RECENT_PUBLISHES = 10;

/** Sync status icons */
export const SYNC_STATUS_ICONS: Record<SyncStatus, string> = {
  'synced': '✓',
  'ahead': '↑',
  'behind': '↓',
  'conflict': '⚠',
  'not-published': '⊘',
  'unknown': '?',
};

/** Sync status colors (ThemeColor) */
export const SYNC_STATUS_COLORS: Record<SyncStatus, string> = {
  'synced': 'charts.green',
  'ahead': 'charts.yellow',
  'behind': 'charts.blue',
  'conflict': 'errorForeground',
  'not-published': 'descriptionForeground',
  'unknown': 'descriptionForeground',
};
```

## Validation Rules Summary

| Field | Required | Type | Validation |
|-------|----------|------|------------|
| `WorkflowVersion.version` | Yes | number | Positive integer |
| `WorkflowVersion.tag` | No | string | Semver pattern if provided |
| `WorkflowVersion.publishedAt` | Yes | string | ISO 8601 datetime |
| `WorkflowVersion.publishedBy` | Yes | string | Non-empty |
| `PublishedWorkflow.name` | Yes | string | Non-empty, matches filename |
| `PublishedWorkflow.currentVersion` | Yes | number | Matches latest in versions array |
| `PublishWorkflowRequest.content` | Yes | string | Valid YAML, max 5MB |
| `PublishWorkflowRequest.changelog` | No | string | No restrictions |

---

*Generated by speckit*
