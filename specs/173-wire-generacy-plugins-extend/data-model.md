# Data Model: Latency Plugin Interfaces

## Core Interfaces

### DevAgent Interface

```typescript
interface DevAgent {
  invoke(prompt: string, options?: InvokeOptions): Promise<AgentResult>;
  invokeStream(prompt: string, options?: InvokeOptions): AsyncIterableIterator<StreamChunk>;
  cancel(invocationId: string): Promise<void>;
  getCapabilities(): Promise<AgentCapabilities>;
}
```

#### AgentResult
```typescript
interface AgentResult {
  invocationId: string;
  output: string;
  exitCode?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}
```

#### InvokeOptions
```typescript
interface InvokeOptions {
  timeoutMs?: number;
  cancellationToken?: CancellationToken;
  workingDirectory?: string;
  environmentVariables?: Record<string, string>;
}
```

#### AgentCapabilities
```typescript
interface AgentCapabilities {
  supportsStreaming: boolean;
  supportsCancel: boolean;
  maxPromptLength?: number;
  supportedModes?: string[];
}
```

---

### CICDPipeline Interface

```typescript
interface CICDPipeline {
  triggerPipeline(pipelineId: string, options?: TriggerOptions): Promise<PipelineRun>;
  getPipelineStatus(runId: string): Promise<PipelineRun>;
  cancelPipeline(runId: string): Promise<void>;
  listPipelines(): Promise<Pipeline[]>;
}
```

#### Pipeline
```typescript
interface Pipeline {
  id: string;
  name: string;
  description?: string;
  defaultBranch?: string;
}
```

#### PipelineRun
```typescript
interface PipelineRun {
  id: string;
  pipelineId: string;
  status: PipelineStatus;
  startedAt?: Date;
  finishedAt?: Date;
  conclusion?: PipelineConclusion;
  logs?: string;
  url?: string;
}
```

#### PipelineStatus
```typescript
type PipelineStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'failed';
```

#### TriggerOptions
```typescript
interface TriggerOptions {
  branch?: string;
  inputs?: Record<string, string>;
  commitSha?: string;
}
```

---

### IssueTracker Interface

```typescript
interface IssueTracker {
  getIssue(id: string): Promise<Issue>;
  createIssue(spec: IssueSpec): Promise<Issue>;
  updateIssue(id: string, update: IssueUpdate): Promise<Issue>;
  listIssues(query: IssueQuery): Promise<PaginatedResult<Issue>>;
  addComment(issueId: string, comment: string): Promise<Comment>;
}
```

#### Issue
```typescript
interface Issue {
  id: string;
  key?: string;          // Jira uses keys like "PROJ-123"
  title: string;
  description?: string;
  status: string;
  type?: string;
  priority?: string;
  assignee?: User;
  reporter?: User;
  labels?: string[];
  createdAt: Date;
  updatedAt: Date;
  url?: string;
}
```

#### IssueSpec
```typescript
interface IssueSpec {
  title: string;
  description?: string;
  type?: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
  projectKey?: string;   // For Jira
}
```

#### IssueUpdate
```typescript
interface IssueUpdate {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  labels?: string[];
}
```

#### IssueQuery
```typescript
interface IssueQuery {
  status?: string | string[];
  assignee?: string;
  labels?: string[];
  createdAfter?: Date;
  createdBefore?: Date;
  search?: string;       // Full-text search
  jql?: string;          // Jira-specific
  maxResults?: number;
  page?: number;
}
```

---

## Supporting Types

### PaginatedResult
```typescript
interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}
```

### Comment
```typescript
interface Comment {
  id: string;
  body: string;
  author: User;
  createdAt: Date;
  updatedAt?: Date;
}
```

### User
```typescript
interface User {
  id: string;
  username: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}
```

### FacetError
```typescript
class FacetError extends Error {
  code: ErrorCode;
  cause?: Error;

  constructor(message: string, code: ErrorCode, cause?: Error);
}

type ErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INTERNAL_ERROR';
```

---

## Type Relationships

```
┌─────────────────────┐
│   AbstractPlugin    │
│  (Latency base)     │
└─────────┬───────────┘
          │ extends
          ▼
┌─────────────────────┐     implements     ┌─────────────────┐
│   GeneracyPlugin    │ ──────────────────▶│    Interface    │
│  (component impl)   │                    │  (DevAgent,     │
└─────────────────────┘                    │   CICDPipeline, │
                                           │   IssueTracker) │
                                           └─────────────────┘
```

## Validation Rules

### IssueSpec Validation
- `title` is required and must be non-empty
- `projectKey` is required for Jira, optional for GitHub

### TriggerOptions Validation
- `branch` must be a valid branch name if provided
- `commitSha` must be a valid SHA if provided

### IssueQuery Validation
- `maxResults` must be positive if provided (default varies by provider)
- `page` must be ≥ 0 if provided
