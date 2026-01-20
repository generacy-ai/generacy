import type { GitHubClient } from '../client.js';
import type {
  Issue,
  CreateIssueParams,
  UpdateIssueParams,
  IssueFilter,
  User,
  Milestone,
} from '../types/index.js';
import {
  validateCreateIssueParams,
  validateUpdateIssueParams,
  validateIssueFilter,
} from '../utils/validation.js';
import { GitHubNotFoundError } from '../utils/errors.js';

/**
 * Transform GitHub API issue response to our Issue type
 */
function transformIssue(apiIssue: {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  labels: Array<{ id?: number; name?: string; color?: string | null; description?: string | null } | string>;
  assignees?: Array<{ id: number; login: string; avatar_url: string; type?: string }> | null;
  milestone?: {
    id: number;
    number: number;
    title: string;
    description: string | null;
    state?: string;
    due_on?: string | null;
  } | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  user: { id: number; login: string; avatar_url: string; type?: string } | null;
  url: string;
  html_url: string;
}): Issue {
  return {
    number: apiIssue.number,
    title: apiIssue.title,
    body: apiIssue.body ?? null,
    state: apiIssue.state as 'open' | 'closed',
    labels: apiIssue.labels
      .filter((l): l is { id?: number; name?: string; color?: string; description?: string | null } =>
        typeof l === 'object'
      )
      .map((l) => ({
        id: l.id ?? 0,
        name: l.name ?? '',
        color: l.color ?? '',
        description: l.description ?? null,
      })),
    assignees: (apiIssue.assignees ?? []).map((a) => ({
      id: a.id,
      login: a.login,
      avatarUrl: a.avatar_url,
      type: (a.type ?? 'User') as User['type'],
    })),
    milestone: apiIssue.milestone
      ? {
          id: apiIssue.milestone.id,
          number: apiIssue.milestone.number,
          title: apiIssue.milestone.title,
          description: apiIssue.milestone.description,
          state: (apiIssue.milestone.state ?? 'open') as Milestone['state'],
          dueOn: apiIssue.milestone.due_on ?? null,
        }
      : null,
    createdAt: apiIssue.created_at,
    updatedAt: apiIssue.updated_at,
    closedAt: apiIssue.closed_at ?? null,
    author: apiIssue.user
      ? {
          id: apiIssue.user.id,
          login: apiIssue.user.login,
          avatarUrl: apiIssue.user.avatar_url,
          type: (apiIssue.user.type ?? 'User') as User['type'],
        }
      : { id: 0, login: 'unknown', avatarUrl: '', type: 'User' },
    url: apiIssue.url,
    htmlUrl: apiIssue.html_url,
  };
}

/**
 * Issue operations using the GitHub client
 */
export class IssueOperations {
  constructor(private readonly client: GitHubClient) {}

  /**
   * Create a new issue
   */
  async create(params: CreateIssueParams): Promise<Issue> {
    const validated = validateCreateIssueParams(params);

    const { data } = await this.client.request(
      () =>
        this.client.rest.issues.create({
          owner: this.client.owner,
          repo: this.client.repo,
          title: validated.title,
          body: validated.body,
          labels: validated.labels,
          assignees: validated.assignees,
          milestone: validated.milestone,
        }),
      'create issue'
    );

    return transformIssue(data);
  }

  /**
   * Get an issue by number
   */
  async get(issueNumber: number): Promise<Issue> {
    const { data } = await this.client.request(
      () =>
        this.client.rest.issues.get({
          owner: this.client.owner,
          repo: this.client.repo,
          issue_number: issueNumber,
        }),
      `get issue #${issueNumber}`
    );

    return transformIssue(data);
  }

  /**
   * Update an issue
   */
  async update(issueNumber: number, params: UpdateIssueParams): Promise<Issue> {
    const validated = validateUpdateIssueParams(params);

    const { data } = await this.client.request(
      () =>
        this.client.rest.issues.update({
          owner: this.client.owner,
          repo: this.client.repo,
          issue_number: issueNumber,
          title: validated.title,
          body: validated.body,
          state: validated.state,
          labels: validated.labels,
          assignees: validated.assignees,
          milestone: validated.milestone,
        }),
      `update issue #${issueNumber}`
    );

    return transformIssue(data);
  }

  /**
   * Close an issue
   */
  async close(issueNumber: number): Promise<void> {
    await this.client.request(
      () =>
        this.client.rest.issues.update({
          owner: this.client.owner,
          repo: this.client.repo,
          issue_number: issueNumber,
          state: 'closed',
        }),
      `close issue #${issueNumber}`
    );
  }

  /**
   * Reopen an issue
   */
  async reopen(issueNumber: number): Promise<void> {
    await this.client.request(
      () =>
        this.client.rest.issues.update({
          owner: this.client.owner,
          repo: this.client.repo,
          issue_number: issueNumber,
          state: 'open',
        }),
      `reopen issue #${issueNumber}`
    );
  }

  /**
   * Search issues using GitHub search syntax
   */
  async search(query: string): Promise<Issue[]> {
    const fullQuery = `repo:${this.client.owner}/${this.client.repo} ${query}`;

    const { data } = await this.client.request(
      () =>
        this.client.rest.search.issuesAndPullRequests({
          q: fullQuery,
          per_page: 100,
        }),
      'search issues'
    );

    // Filter out pull requests (they're included in the search results)
    return data.items
      .filter((item) => !('pull_request' in item))
      .map((item) => transformIssue(item as Parameters<typeof transformIssue>[0]));
  }

  /**
   * List issues with optional filtering
   */
  async list(filter?: IssueFilter): Promise<Issue[]> {
    const validated = filter ? validateIssueFilter(filter) : {};

    const results = await this.client.paginate(
      (params) =>
        this.client.rest.issues.listForRepo({
          owner: this.client.owner,
          repo: this.client.repo,
          state: validated.state,
          labels: validated.labels?.join(','),
          assignee: validated.assignee,
          creator: validated.creator,
          mentioned: validated.mentioned,
          milestone:
            validated.milestone === 'none' || validated.milestone === '*'
              ? validated.milestone
              : validated.milestone?.toString(),
          since: validated.since,
          sort: validated.sort,
          direction: validated.direction,
          ...params,
        }),
      10
    );

    // Filter out pull requests
    return results
      .filter((item) => !('pull_request' in item))
      .map((item) => transformIssue(item as Parameters<typeof transformIssue>[0]));
  }

  /**
   * Check if an issue exists
   */
  async exists(issueNumber: number): Promise<boolean> {
    try {
      await this.get(issueNumber);
      return true;
    } catch (error) {
      if (error instanceof GitHubNotFoundError) {
        return false;
      }
      throw error;
    }
  }
}

/**
 * Create issue operations instance
 */
export function createIssueOperations(client: GitHubClient): IssueOperations {
  return new IssueOperations(client);
}
