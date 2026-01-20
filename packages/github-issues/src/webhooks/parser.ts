import type {
  WebhookEvent,
  IssuesEventPayload,
  IssueCommentEventPayload,
  PullRequestEventPayload,
  WebhookEventName,
  TypedWebhookEvent,
  Issue,
  User,
  Label,
  Comment,
  PullRequest,
  Repository,
} from '../types/index.js';
import { GitHubValidationError } from '../utils/errors.js';

/**
 * Raw webhook payload from GitHub
 */
export interface RawWebhookPayload {
  action?: string;
  issue?: Record<string, unknown>;
  comment?: Record<string, unknown>;
  pull_request?: Record<string, unknown>;
  sender?: Record<string, unknown>;
  repository?: Record<string, unknown>;
  assignee?: Record<string, unknown>;
  label?: Record<string, unknown>;
  changes?: Record<string, unknown>;
}

/**
 * Transform raw user data to User type
 */
function parseUser(raw: Record<string, unknown>): User {
  return {
    id: (raw.id as number) ?? 0,
    login: (raw.login as string) ?? 'unknown',
    avatarUrl: (raw.avatar_url as string) ?? '',
    type: ((raw.type as string) ?? 'User') as User['type'],
  };
}

/**
 * Transform raw label data to Label type
 */
function parseLabel(raw: Record<string, unknown>): Label {
  return {
    id: (raw.id as number) ?? 0,
    name: (raw.name as string) ?? '',
    color: (raw.color as string) ?? '',
    description: (raw.description as string | null) ?? null,
  };
}

/**
 * Transform raw repository data to Repository type
 */
function parseRepository(raw: Record<string, unknown>): Repository {
  const owner = raw.owner as Record<string, unknown> | undefined;
  return {
    id: (raw.id as number) ?? 0,
    name: (raw.name as string) ?? '',
    fullName: (raw.full_name as string) ?? '',
    owner: owner ? parseUser(owner) : { id: 0, login: 'unknown', avatarUrl: '', type: 'User' },
    htmlUrl: (raw.html_url as string) ?? '',
    private: (raw.private as boolean) ?? false,
  };
}

/**
 * Transform raw issue data to Issue type
 */
function parseIssue(raw: Record<string, unknown>): Issue {
  const labels = (raw.labels as Array<Record<string, unknown>> | undefined) ?? [];
  const assignees = (raw.assignees as Array<Record<string, unknown>> | undefined) ?? [];
  const milestone = raw.milestone as Record<string, unknown> | null | undefined;
  const user = raw.user as Record<string, unknown> | null | undefined;

  return {
    number: (raw.number as number) ?? 0,
    title: (raw.title as string) ?? '',
    body: (raw.body as string | null) ?? null,
    state: ((raw.state as string) ?? 'open') as Issue['state'],
    labels: labels.map(parseLabel),
    assignees: assignees.map(parseUser),
    milestone: milestone
      ? {
          id: (milestone.id as number) ?? 0,
          number: (milestone.number as number) ?? 0,
          title: (milestone.title as string) ?? '',
          description: (milestone.description as string | null) ?? null,
          state: ((milestone.state as string) ?? 'open') as 'open' | 'closed',
          dueOn: (milestone.due_on as string | null) ?? null,
        }
      : null,
    createdAt: (raw.created_at as string) ?? '',
    updatedAt: (raw.updated_at as string) ?? '',
    closedAt: (raw.closed_at as string | null) ?? null,
    author: user ? parseUser(user) : { id: 0, login: 'unknown', avatarUrl: '', type: 'User' },
    url: (raw.url as string) ?? '',
    htmlUrl: (raw.html_url as string) ?? '',
  };
}

/**
 * Transform raw comment data to Comment type
 */
function parseComment(raw: Record<string, unknown>): Comment {
  const user = raw.user as Record<string, unknown> | null | undefined;

  return {
    id: (raw.id as number) ?? 0,
    body: (raw.body as string) ?? '',
    author: user ? parseUser(user) : { id: 0, login: 'unknown', avatarUrl: '', type: 'User' },
    createdAt: (raw.created_at as string) ?? '',
    updatedAt: (raw.updated_at as string) ?? '',
    htmlUrl: (raw.html_url as string) ?? '',
  };
}

/**
 * Transform raw pull request data to PullRequest type
 */
function parsePullRequest(raw: Record<string, unknown>): PullRequest {
  const user = raw.user as Record<string, unknown> | null | undefined;
  const body = raw.body as string | null | undefined;

  // Extract linked issues from body
  const linkedIssues: number[] = [];
  if (body) {
    const patterns = [
      /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(body)) !== null) {
        const issueNum = parseInt(match[1] ?? '', 10);
        if (!isNaN(issueNum) && !linkedIssues.includes(issueNum)) {
          linkedIssues.push(issueNum);
        }
      }
    }
  }

  // Determine state
  let state: PullRequest['state'] = (raw.state as string ?? 'open') as 'open' | 'closed';
  if (raw.merged === true) {
    state = 'merged';
  }

  return {
    number: (raw.number as number) ?? 0,
    title: (raw.title as string) ?? '',
    state,
    author: user ? parseUser(user) : { id: 0, login: 'unknown', avatarUrl: '', type: 'User' },
    htmlUrl: (raw.html_url as string) ?? '',
    linkedIssues,
  };
}

/**
 * Parse an issues webhook event payload
 */
function parseIssuesEvent(payload: RawWebhookPayload): IssuesEventPayload {
  if (!payload.action || !payload.issue || !payload.sender || !payload.repository) {
    throw new GitHubValidationError('Invalid issues event payload');
  }

  return {
    action: payload.action as IssuesEventPayload['action'],
    issue: parseIssue(payload.issue),
    sender: parseUser(payload.sender),
    repository: parseRepository(payload.repository),
    assignee: payload.assignee ? parseUser(payload.assignee) : undefined,
    label: payload.label ? parseLabel(payload.label) : undefined,
    changes: payload.changes as Record<string, { from: unknown }> | undefined,
  };
}

/**
 * Parse an issue_comment webhook event payload
 */
function parseIssueCommentEvent(payload: RawWebhookPayload): IssueCommentEventPayload {
  if (!payload.action || !payload.issue || !payload.comment || !payload.sender || !payload.repository) {
    throw new GitHubValidationError('Invalid issue_comment event payload');
  }

  return {
    action: payload.action as IssueCommentEventPayload['action'],
    issue: parseIssue(payload.issue),
    comment: parseComment(payload.comment),
    sender: parseUser(payload.sender),
    repository: parseRepository(payload.repository),
    changes: payload.changes as Record<string, { from: unknown }> | undefined,
  };
}

/**
 * Parse a pull_request webhook event payload
 */
function parsePullRequestEvent(payload: RawWebhookPayload): PullRequestEventPayload {
  if (!payload.action || !payload.pull_request || !payload.sender || !payload.repository) {
    throw new GitHubValidationError('Invalid pull_request event payload');
  }

  return {
    action: payload.action as PullRequestEventPayload['action'],
    pull_request: parsePullRequest(payload.pull_request),
    sender: parseUser(payload.sender),
    repository: parseRepository(payload.repository),
  };
}

/**
 * Parse a raw webhook event into a typed event
 */
export function parseWebhookEvent(
  eventName: string,
  payload: unknown,
  deliveryId?: string
): TypedWebhookEvent {
  const rawPayload = payload as RawWebhookPayload;

  switch (eventName as WebhookEventName) {
    case 'issues':
      return {
        name: eventName,
        payload: parseIssuesEvent(rawPayload),
        deliveryId,
      } as WebhookEvent<IssuesEventPayload>;

    case 'issue_comment':
      return {
        name: eventName,
        payload: parseIssueCommentEvent(rawPayload),
        deliveryId,
      } as WebhookEvent<IssueCommentEventPayload>;

    case 'pull_request':
      return {
        name: eventName,
        payload: parsePullRequestEvent(rawPayload),
        deliveryId,
      } as WebhookEvent<PullRequestEventPayload>;

    default:
      throw new GitHubValidationError(`Unsupported webhook event type: ${eventName}`);
  }
}

/**
 * Check if an event name is a supported webhook event
 */
export function isSupportedEvent(eventName: string): eventName is WebhookEventName {
  return ['issues', 'issue_comment', 'pull_request'].includes(eventName);
}

/**
 * Type guard for IssuesEventPayload
 */
export function isIssuesEvent(
  event: TypedWebhookEvent
): event is WebhookEvent<IssuesEventPayload> {
  return event.name === 'issues';
}

/**
 * Type guard for IssueCommentEventPayload
 */
export function isIssueCommentEvent(
  event: TypedWebhookEvent
): event is WebhookEvent<IssueCommentEventPayload> {
  return event.name === 'issue_comment';
}

/**
 * Type guard for PullRequestEventPayload
 */
export function isPullRequestEvent(
  event: TypedWebhookEvent
): event is WebhookEvent<PullRequestEventPayload> {
  return event.name === 'pull_request';
}
