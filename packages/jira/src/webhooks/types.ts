import type { JiraUser, JiraIssue } from '../types/issues.js';
import type { JiraComment } from '../types/events.js';
import type { Sprint } from '../types/sprints.js';

/**
 * Jira webhook event types
 */
export type JiraEventType =
  | 'jira:issue_created'
  | 'jira:issue_updated'
  | 'jira:issue_deleted'
  | 'comment_created'
  | 'comment_updated'
  | 'comment_deleted'
  | 'sprint_created'
  | 'sprint_updated'
  | 'sprint_started'
  | 'sprint_closed'
  | 'issuelink_created'
  | 'issuelink_deleted'
  | 'worklog_created'
  | 'worklog_updated'
  | 'worklog_deleted';

/**
 * Changelog item for tracking field changes
 */
export interface ChangelogItem {
  field: string;
  fieldtype: string;
  fieldId: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
}

/**
 * Changelog for issue updates
 */
export interface Changelog {
  id: string;
  items: ChangelogItem[];
}

/**
 * Base webhook event structure
 */
export interface JiraWebhookEventBase {
  webhookEvent: JiraEventType;
  timestamp: number;
  user: JiraUser;
}

/**
 * Issue-related webhook events
 */
export interface JiraIssueEvent extends JiraWebhookEventBase {
  webhookEvent: 'jira:issue_created' | 'jira:issue_updated' | 'jira:issue_deleted';
  issue: JiraIssue;
  changelog?: Changelog;
}

/**
 * Comment-related webhook events
 */
export interface JiraCommentEvent extends JiraWebhookEventBase {
  webhookEvent: 'comment_created' | 'comment_updated' | 'comment_deleted';
  issue: JiraIssue;
  comment: JiraComment;
}

/**
 * Sprint-related webhook events
 */
export interface JiraSprintEvent extends JiraWebhookEventBase {
  webhookEvent: 'sprint_created' | 'sprint_updated' | 'sprint_started' | 'sprint_closed';
  sprint: Sprint;
}

/**
 * Union type for all webhook events
 */
export type JiraWebhookEvent =
  | JiraIssueEvent
  | JiraCommentEvent
  | JiraSprintEvent;

/**
 * Parsed webhook action types
 */
export type WebhookActionType =
  | 'issue_created'
  | 'issue_updated'
  | 'issue_deleted'
  | 'issue_assigned'
  | 'issue_unassigned'
  | 'issue_transitioned'
  | 'comment_added'
  | 'comment_updated'
  | 'comment_deleted'
  | 'sprint_started'
  | 'sprint_closed'
  | 'priority_changed'
  | 'labels_changed'
  | 'unknown';

/**
 * Parsed webhook action with details
 */
export interface WebhookAction {
  type: WebhookActionType;
  issueKey?: string;
  issueId?: string;
  userId?: string;
  userDisplayName?: string;
  timestamp: Date;
  changes?: ChangelogItem[];
  previousStatus?: string;
  newStatus?: string;
  previousAssignee?: string;
  newAssignee?: string;
}

/**
 * Webhook handler callback signature
 */
export type WebhookHandler = (
  event: JiraWebhookEvent,
  action: WebhookAction
) => Promise<void> | void;

/**
 * Webhook handler registration
 */
export interface WebhookHandlerRegistration {
  eventTypes: JiraEventType[];
  actionTypes?: WebhookActionType[];
  handler: WebhookHandler;
}
