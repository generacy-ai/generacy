# Data Model: @generacy-ai/generacy-plugin-copilot

## Core Entities

### Workspace

Represents a Copilot Workspace session associated with a GitHub issue.

```typescript
/**
 * Represents a Copilot Workspace instance.
 */
export interface Workspace {
  /** Unique workspace identifier (generated locally since no API) */
  readonly id: string;

  /** GitHub issue URL that triggered this workspace */
  readonly issueUrl: string;

  /** Current workspace status */
  readonly status: WorkspaceStatus;

  /** When the workspace tracking started */
  readonly createdAt: Date;

  /** Last status update */
  readonly updatedAt: Date;

  /** Associated pull request URL (when available) */
  readonly pullRequestUrl?: string;

  /** Repository owner */
  readonly owner: string;

  /** Repository name */
  readonly repo: string;

  /** Issue number */
  readonly issueNumber: number;
}
```

### WorkspaceStatus

Status enumeration for workspace lifecycle.

```typescript
/**
 * Workspace lifecycle states.
 */
export type WorkspaceStatus =
  | 'pending'        // Workspace tracking initiated, awaiting manual trigger
  | 'planning'       // Copilot is analyzing the issue
  | 'implementing'   // Copilot is generating code
  | 'review_ready'   // PR created, ready for review
  | 'merged'         // PR has been merged
  | 'failed'         // Workspace failed or was cancelled
  | 'not_available'; // Copilot API not available
```

### WorkspaceStatusEvent

Event emitted during status streaming.

```typescript
/**
 * Status update event for streaming.
 */
export interface WorkspaceStatusEvent {
  /** Workspace ID */
  workspaceId: string;

  /** Previous status */
  previousStatus: WorkspaceStatus;

  /** New status */
  status: WorkspaceStatus;

  /** Event timestamp */
  timestamp: Date;

  /** Additional context */
  details?: {
    /** PR URL if status is review_ready */
    pullRequestUrl?: string;
    /** Failure reason if status is failed */
    failureReason?: string;
    /** Progress percentage (0-100) if available */
    progress?: number;
  };
}
```

## Configuration Types

### CopilotPluginOptions

Plugin initialization options.

```typescript
/**
 * Configuration options for CopilotPlugin.
 */
export interface CopilotPluginOptions {
  /** GitHub personal access token or GitHub App token */
  githubToken: string;

  /** GitHub API base URL (for GitHub Enterprise) */
  apiBaseUrl?: string;

  /** Logger instance or pino options */
  logger?: Logger | LoggerOptions;

  /** Default polling configuration */
  polling?: PollingConfig;

  /** Default workspace options */
  workspaceDefaults?: WorkspaceOptions;
}
```

### WorkspaceOptions

Options for workspace creation.

```typescript
/**
 * Options for workspace behavior.
 */
export interface WorkspaceOptions {
  /** Auto-merge PR when checks pass */
  autoMerge?: boolean;

  /** Require review before merge */
  reviewRequired?: boolean;

  /** Maximum time to wait for workspace completion (ms) */
  timeoutMs?: number;

  /** Labels to apply to created PR */
  prLabels?: string[];
}
```

### PollingConfig

Status polling configuration.

```typescript
/**
 * Polling behavior configuration.
 */
export interface PollingConfig {
  /** Initial polling interval in milliseconds */
  initialIntervalMs: number;

  /** Maximum polling interval in milliseconds */
  maxIntervalMs: number;

  /** Backoff multiplier for interval growth */
  backoffMultiplier: number;

  /** Maximum number of poll attempts */
  maxRetries: number;

  /** Timeout for the entire polling operation (ms) */
  timeoutMs?: number;
}
```

## Output Types

### FileChange

Represents a file change from the workspace.

```typescript
/**
 * A file change produced by Copilot Workspace.
 */
export interface FileChange {
  /** File path relative to repository root */
  path: string;

  /** Type of change */
  type: 'added' | 'modified' | 'deleted' | 'renamed';

  /** Previous path (for renames) */
  previousPath?: string;

  /** Number of additions */
  additions: number;

  /** Number of deletions */
  deletions: number;

  /** File content (if available) */
  content?: string;

  /** File patch in unified diff format */
  patch?: string;
}
```

### PullRequest

Pull request information.

```typescript
/**
 * Pull request created by Copilot Workspace.
 */
export interface PullRequest {
  /** PR number */
  number: number;

  /** PR URL */
  url: string;

  /** PR title */
  title: string;

  /** PR body/description */
  body: string;

  /** PR state */
  state: 'open' | 'closed' | 'merged';

  /** Head branch */
  head: string;

  /** Base branch */
  base: string;

  /** Whether PR is mergeable */
  mergeable?: boolean;

  /** Associated issue numbers */
  linkedIssues: number[];

  /** Review status */
  reviewStatus: 'pending' | 'approved' | 'changes_requested' | 'dismissed';

  /** Files changed */
  changedFiles: number;

  /** Total additions */
  additions: number;

  /** Total deletions */
  deletions: number;
}
```

## Error Types

### PluginError

Base error class for all plugin errors.

```typescript
/**
 * Base error for plugin operations.
 */
export interface PluginErrorData {
  /** Error classification code */
  code: ErrorCode;

  /** Whether error is retryable */
  isTransient: boolean;

  /** Additional error context */
  context?: Record<string, unknown>;
}

export type ErrorCode =
  | 'WORKSPACE_NOT_FOUND'
  | 'WORKSPACE_INVALID_STATE'
  | 'GITHUB_API_ERROR'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'POLLING_TIMEOUT'
  | 'NOT_IMPLEMENTED'
  | 'UNKNOWN';
```

## Internal Types

### InternalWorkspace

Extended workspace type for internal state management.

```typescript
/**
 * Internal workspace representation with mutable state.
 */
export interface InternalWorkspace {
  /** Public workspace data */
  workspace: Workspace;

  /** Polling state */
  pollState: {
    lastPolledAt?: Date;
    pollCount: number;
    currentIntervalMs: number;
  };

  /** Associated GitHub data */
  github: {
    issueId: number;
    linkedPRNumbers: number[];
  };

  /** Workspace options */
  options: WorkspaceOptions;
}
```

## Validation Rules

### Issue URL Validation

```typescript
const GITHUB_ISSUE_URL_REGEX =
  /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)$/;

function validateIssueUrl(url: string): { owner: string; repo: string; issueNumber: number } {
  const match = url.match(GITHUB_ISSUE_URL_REGEX);
  if (!match) {
    throw new Error('Invalid GitHub issue URL format');
  }
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: parseInt(match[3], 10),
  };
}
```

### Token Validation

```typescript
function validateGitHubToken(token: string): boolean {
  // GitHub tokens start with specific prefixes
  const validPrefixes = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_'];
  return validPrefixes.some(prefix => token.startsWith(prefix)) ||
         token.length === 40; // Classic tokens
}
```

## Entity Relationships

```
CopilotPlugin
    │
    ├── manages ──► InternalWorkspace[]
    │                    │
    │                    ├── contains ──► Workspace (public view)
    │                    │
    │                    └── references ──► GitHub Issue
    │                                          │
    │                                          └── links to ──► Pull Request
    │
    └── uses ──► GitHub API Client
                     │
                     └── authenticated via ──► GitHub Token
```

## State Transitions

```
                    ┌─────────────────┐
                    │     pending     │
                    └────────┬────────┘
                             │ (manual trigger detected)
                             ▼
                    ┌─────────────────┐
                    │    planning     │
                    └────────┬────────┘
                             │ (implementation started)
                             ▼
                    ┌─────────────────┐
                    │  implementing   │
                    └────────┬────────┘
                             │ (PR created)
                             ▼
                    ┌─────────────────┐
                    │  review_ready   │
                    └────────┬────────┘
                             │ (PR merged)
                             ▼
                    ┌─────────────────┐
                    │     merged      │
                    └─────────────────┘

    Any state can transition to:
    - failed (on error/cancellation)
    - not_available (when API unavailable)
```
