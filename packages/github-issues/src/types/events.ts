import type { Issue, User, Label, Comment, PullRequest } from './issues.js';

/**
 * Repository reference in webhook events
 */
export interface Repository {
  id: number;
  name: string;
  fullName: string;
  owner: User;
  htmlUrl: string;
  private: boolean;
}

/**
 * Base webhook event structure
 */
export interface WebhookEvent<T = unknown> {
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
export interface IssuesEventPayload {
  action:
    | 'opened'
    | 'edited'
    | 'deleted'
    | 'transferred'
    | 'pinned'
    | 'unpinned'
    | 'closed'
    | 'reopened'
    | 'assigned'
    | 'unassigned'
    | 'labeled'
    | 'unlabeled'
    | 'locked'
    | 'unlocked'
    | 'milestoned'
    | 'demilestoned';
  issue: Issue;
  sender: User;
  repository: Repository;

  /** Assignee when action is 'assigned' or 'unassigned' */
  assignee?: User;

  /** Label when action is 'labeled' or 'unlabeled' */
  label?: Label;

  /** Field changes when action is 'edited' */
  changes?: Record<string, { from: unknown }>;
}

/**
 * Issue comment webhook event payload
 */
export interface IssueCommentEventPayload {
  action: 'created' | 'edited' | 'deleted';
  issue: Issue;
  comment: Comment;
  sender: User;
  repository: Repository;

  /** Field changes when action is 'edited' */
  changes?: Record<string, { from: unknown }>;
}

/**
 * Pull request webhook event payload
 */
export interface PullRequestEventPayload {
  action:
    | 'opened'
    | 'edited'
    | 'closed'
    | 'reopened'
    | 'assigned'
    | 'unassigned'
    | 'labeled'
    | 'unlabeled'
    | 'synchronize'
    | 'ready_for_review'
    | 'locked'
    | 'unlocked'
    | 'review_requested';
  pull_request: PullRequest;
  sender: User;
  repository: Repository;
}

/**
 * Supported webhook event names
 */
export type WebhookEventName = 'issues' | 'issue_comment' | 'pull_request';

/**
 * Type-safe webhook event union
 */
export type TypedWebhookEvent =
  | WebhookEvent<IssuesEventPayload>
  | WebhookEvent<IssueCommentEventPayload>
  | WebhookEvent<PullRequestEventPayload>;
