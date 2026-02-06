import type {
  JiraWebhookEvent,
  JiraIssueEvent,
  JiraCommentEvent,
  WebhookAction,
  WebhookActionType,
  ChangelogItem,
  Changelog,
} from './types.js';

/**
 * Parse a raw webhook payload into a typed event
 */
export function parseWebhookPayload(payload: unknown): JiraWebhookEvent {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid webhook payload: expected object');
  }

  const data = payload as Record<string, unknown>;

  if (!data.webhookEvent || typeof data.webhookEvent !== 'string') {
    throw new Error('Invalid webhook payload: missing webhookEvent');
  }

  // The payload structure varies by event type, but we can cast safely
  // since Jira sends consistent payloads per event type
  return data as unknown as JiraWebhookEvent;
}

/**
 * Extract changes from a changelog
 */
export function extractChanges(changelog?: Changelog): ChangelogItem[] {
  return changelog?.items ?? [];
}

/**
 * Check if a specific field was changed
 */
export function hasFieldChange(
  changelog: Changelog | undefined,
  fieldName: string
): boolean {
  return extractChanges(changelog).some(
    (item) => item.field.toLowerCase() === fieldName.toLowerCase()
  );
}

/**
 * Get the change for a specific field
 */
export function getFieldChange(
  changelog: Changelog | undefined,
  fieldName: string
): ChangelogItem | undefined {
  return extractChanges(changelog).find(
    (item) => item.field.toLowerCase() === fieldName.toLowerCase()
  );
}

/**
 * Determine the action type from an issue event
 */
function determineIssueActionType(event: JiraIssueEvent): WebhookActionType {
  if (event.webhookEvent === 'jira:issue_created') {
    return 'issue_created';
  }

  if (event.webhookEvent === 'jira:issue_deleted') {
    return 'issue_deleted';
  }

  // For updates, check what changed
  if (hasFieldChange(event.changelog, 'status')) {
    return 'issue_transitioned';
  }

  if (hasFieldChange(event.changelog, 'assignee')) {
    const assigneeChange = getFieldChange(event.changelog, 'assignee');
    if (assigneeChange?.to === null || assigneeChange?.toString === null) {
      return 'issue_unassigned';
    }
    return 'issue_assigned';
  }

  if (hasFieldChange(event.changelog, 'priority')) {
    return 'priority_changed';
  }

  if (hasFieldChange(event.changelog, 'labels')) {
    return 'labels_changed';
  }

  return 'issue_updated';
}

/**
 * Determine the action type from a comment event
 */
function determineCommentActionType(event: JiraCommentEvent): WebhookActionType {
  switch (event.webhookEvent) {
    case 'comment_created':
      return 'comment_added';
    case 'comment_updated':
      return 'comment_updated';
    case 'comment_deleted':
      return 'comment_deleted';
  }
}

/**
 * Parse webhook event into a normalized action
 */
export function parseWebhookAction(event: JiraWebhookEvent): WebhookAction {
  const base: WebhookAction = {
    type: 'unknown',
    timestamp: new Date(event.timestamp),
    userId: event.user?.accountId,
    userDisplayName: event.user?.displayName,
  };

  // Handle issue events
  if (event.webhookEvent.startsWith('jira:issue_')) {
    const issueEvent = event as JiraIssueEvent;
    const action: WebhookAction = {
      ...base,
      type: determineIssueActionType(issueEvent),
      issueKey: issueEvent.issue?.key,
      issueId: issueEvent.issue?.id,
      changes: extractChanges(issueEvent.changelog),
    };

    // Add status transition details
    if (action.type === 'issue_transitioned') {
      const statusChange = getFieldChange(issueEvent.changelog, 'status');
      action.previousStatus = statusChange?.fromString ?? undefined;
      action.newStatus = statusChange?.toString ?? undefined;
    }

    // Add assignee details
    if (action.type === 'issue_assigned' || action.type === 'issue_unassigned') {
      const assigneeChange = getFieldChange(issueEvent.changelog, 'assignee');
      action.previousAssignee = assigneeChange?.fromString ?? undefined;
      action.newAssignee = assigneeChange?.toString ?? undefined;
    }

    return action;
  }

  // Handle comment events
  if (event.webhookEvent.startsWith('comment_')) {
    const commentEvent = event as JiraCommentEvent;
    return {
      ...base,
      type: determineCommentActionType(commentEvent),
      issueKey: commentEvent.issue?.key,
      issueId: commentEvent.issue?.id,
    };
  }

  // Handle sprint events
  if (event.webhookEvent.startsWith('sprint_')) {
    switch (event.webhookEvent) {
      case 'sprint_started':
        return { ...base, type: 'sprint_started' };
      case 'sprint_closed':
        return { ...base, type: 'sprint_closed' };
    }
  }

  return base;
}

/**
 * Check if an event is for a specific issue
 */
export function isEventForIssue(
  event: JiraWebhookEvent,
  issueKey: string
): boolean {
  if ('issue' in event && event.issue) {
    return event.issue.key === issueKey;
  }
  return false;
}

/**
 * Check if an event involves a specific user
 */
export function isEventByUser(
  event: JiraWebhookEvent,
  accountId: string
): boolean {
  return event.user?.accountId === accountId;
}

/**
 * Get the issue key from any webhook event
 */
export function getIssueKeyFromEvent(event: JiraWebhookEvent): string | null {
  if ('issue' in event && event.issue) {
    return event.issue.key;
  }
  return null;
}
