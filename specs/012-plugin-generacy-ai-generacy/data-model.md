# Data Model: @generacy-ai/generacy-plugin-github-issues

## Core Entities

### Configuration

```typescript
/**
 * Plugin configuration
 */
interface GitHubIssuesConfig {
  /** Repository owner (user or organization) */
  owner: string;

  /** Repository name */
  repo: string;

  /** GitHub authentication token (PAT or installation token) */
  token: string;

  /** Webhook secret for signature verification */
  webhookSecret?: string;

  /** Agent account username for assignment detection */
  agentAccount?: string;

  /** Labels that trigger workflow start */
  triggerLabels?: string[];

  /** GitHub Enterprise base URL */
  baseUrl?: string;
}
```

### Issue Types

```typescript
/**
 * GitHub issue representation
 */
interface Issue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: Label[];
  assignees: User[];
  milestone: Milestone | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: User;
  url: string;
  htmlUrl: string;
}

/**
 * Parameters for creating an issue
 */
interface CreateIssueParams {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number;
}

/**
 * Parameters for updating an issue
 */
interface UpdateIssueParams {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
}

/**
 * Filter for listing issues
 */
interface IssueFilter {
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  assignee?: string;
  creator?: string;
  mentioned?: string;
  milestone?: number | 'none' | '*';
  since?: string;
  sort?: 'created' | 'updated' | 'comments';
  direction?: 'asc' | 'desc';
}
```

### Supporting Types

```typescript
/**
 * GitHub user
 */
interface User {
  id: number;
  login: string;
  avatarUrl: string;
  type: 'User' | 'Bot' | 'Organization';
}

/**
 * Issue label
 */
interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

/**
 * Issue comment
 */
interface Comment {
  id: number;
  body: string;
  author: User;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

/**
 * Pull request reference
 */
interface PullRequest {
  number: number;
  title: string;
  state: 'open' | 'closed' | 'merged';
  author: User;
  htmlUrl: string;
  linkedIssues: number[];
}

/**
 * Milestone
 */
interface Milestone {
  id: number;
  number: number;
  title: string;
  description: string | null;
  state: 'open' | 'closed';
  dueOn: string | null;
}
```

## Webhook Events

```typescript
/**
 * Base webhook event structure
 */
interface WebhookEvent<T = unknown> {
  /** Event type (e.g., 'issues', 'issue_comment') */
  name: string;

  /** Event payload from GitHub */
  payload: T;

  /** Delivery ID for idempotency */
  deliveryId?: string;
}

/**
 * Issues webhook event payload
 */
interface IssuesEventPayload {
  action: 'opened' | 'edited' | 'deleted' | 'transferred' | 'pinned' |
          'unpinned' | 'closed' | 'reopened' | 'assigned' | 'unassigned' |
          'labeled' | 'unlabeled' | 'locked' | 'unlocked' | 'milestoned' |
          'demilestoned';
  issue: Issue;
  sender: User;
  repository: Repository;

  // Action-specific fields
  assignee?: User;
  label?: Label;
  changes?: Record<string, { from: unknown }>;
}

/**
 * Issue comment webhook event payload
 */
interface IssueCommentEventPayload {
  action: 'created' | 'edited' | 'deleted';
  issue: Issue;
  comment: Comment;
  sender: User;
  repository: Repository;
  changes?: Record<string, { from: unknown }>;
}

/**
 * Pull request webhook event payload
 */
interface PullRequestEventPayload {
  action: 'opened' | 'edited' | 'closed' | 'reopened' | 'assigned' |
          'unassigned' | 'labeled' | 'unlabeled' | 'synchronize' |
          'ready_for_review' | 'locked' | 'unlocked' | 'review_requested';
  pull_request: PullRequest;
  sender: User;
  repository: Repository;
}
```

## Workflow Actions

```typescript
/**
 * Action to take based on webhook event
 */
type WorkflowAction =
  | QueueForProcessingAction
  | StartWorkflowAction
  | ResumeWorkflowAction
  | NoAction;

interface QueueForProcessingAction {
  type: 'queue_for_processing';
  issueNumber: number;
  priority?: 'high' | 'normal' | 'low';
}

interface StartWorkflowAction {
  type: 'start_workflow';
  issueNumber: number;
  workflowType?: string;
}

interface ResumeWorkflowAction {
  type: 'resume_workflow';
  issueNumber: number;
  triggeredBy: 'comment' | 'label';
}

interface NoAction {
  type: 'no_action';
  reason: string;
}
```

## Zod Schemas

```typescript
import { z } from 'zod';

// Configuration schema
const GitHubIssuesConfigSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  token: z.string().min(1),
  webhookSecret: z.string().optional(),
  agentAccount: z.string().optional(),
  triggerLabels: z.array(z.string()).optional(),
  baseUrl: z.string().url().optional(),
});

// Create issue schema
const CreateIssueParamsSchema = z.object({
  title: z.string().min(1).max(256),
  body: z.string().max(65536).optional(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  milestone: z.number().positive().optional(),
});

// Update issue schema
const UpdateIssueParamsSchema = z.object({
  title: z.string().min(1).max(256).optional(),
  body: z.string().max(65536).optional(),
  state: z.enum(['open', 'closed']).optional(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  milestone: z.number().positive().nullable().optional(),
});

// Issue filter schema
const IssueFilterSchema = z.object({
  state: z.enum(['open', 'closed', 'all']).optional(),
  labels: z.array(z.string()).optional(),
  assignee: z.string().optional(),
  creator: z.string().optional(),
  mentioned: z.string().optional(),
  milestone: z.union([z.number(), z.literal('none'), z.literal('*')]).optional(),
  since: z.string().datetime().optional(),
  sort: z.enum(['created', 'updated', 'comments']).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
});
```

## Type Exports

```typescript
// src/types/index.ts
export type {
  // Config
  GitHubIssuesConfig,

  // Issues
  Issue,
  CreateIssueParams,
  UpdateIssueParams,
  IssueFilter,

  // Supporting
  User,
  Label,
  Comment,
  PullRequest,
  Milestone,

  // Events
  WebhookEvent,
  IssuesEventPayload,
  IssueCommentEventPayload,
  PullRequestEventPayload,

  // Actions
  WorkflowAction,
  QueueForProcessingAction,
  StartWorkflowAction,
  ResumeWorkflowAction,
  NoAction,
};

export {
  GitHubIssuesConfigSchema,
  CreateIssueParamsSchema,
  UpdateIssueParamsSchema,
  IssueFilterSchema,
};
```

---

*Generated by speckit*
