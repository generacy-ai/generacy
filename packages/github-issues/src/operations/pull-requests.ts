import type { GitHubClient } from '../client.js';
import type { PullRequest, User } from '../types/index.js';

/**
 * Transform GitHub API PR response to our PullRequest type
 */
function transformPullRequest(apiPR: {
  number: number;
  title: string;
  state: string;
  merged?: boolean;
  user: { id: number; login: string; avatar_url: string; type?: string } | null;
  html_url: string;
  body?: string | null;
}): PullRequest {
  // Determine the effective state
  let state: PullRequest['state'] = apiPR.state as 'open' | 'closed';
  if (apiPR.state === 'closed' && apiPR.merged) {
    state = 'merged';
  }

  // Extract linked issue numbers from PR body
  const linkedIssues: number[] = [];
  if (apiPR.body) {
    // Match common patterns: Fixes #123, Closes #456, etc.
    const patterns = [
      /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi,
      /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/)(\d+)/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(apiPR.body)) !== null) {
        const issueNum = parseInt(match[1] ?? '', 10);
        if (!isNaN(issueNum) && !linkedIssues.includes(issueNum)) {
          linkedIssues.push(issueNum);
        }
      }
    }
  }

  return {
    number: apiPR.number,
    title: apiPR.title,
    state,
    author: apiPR.user
      ? {
          id: apiPR.user.id,
          login: apiPR.user.login,
          avatarUrl: apiPR.user.avatar_url,
          type: (apiPR.user.type ?? 'User') as User['type'],
        }
      : { id: 0, login: 'unknown', avatarUrl: '', type: 'User' },
    htmlUrl: apiPR.html_url,
    linkedIssues,
  };
}

/**
 * Pull request operations using the GitHub client
 */
export class PullRequestOperations {
  constructor(private readonly client: GitHubClient) {}

  /**
   * Get a pull request by number
   */
  async get(prNumber: number): Promise<PullRequest> {
    const { data } = await this.client.request(
      () =>
        this.client.rest.pulls.get({
          owner: this.client.owner,
          repo: this.client.repo,
          pull_number: prNumber,
        }),
      `get PR #${prNumber}`
    );

    return transformPullRequest(data);
  }

  /**
   * Link a pull request to an issue by adding a comment
   * Note: GitHub automatically links PRs that reference issues in their description
   * This method adds an explicit link comment
   */
  async linkToIssue(prNumber: number, issueNumber: number): Promise<void> {
    // Add a comment to the PR referencing the issue
    await this.client.request(
      () =>
        this.client.rest.issues.createComment({
          owner: this.client.owner,
          repo: this.client.repo,
          issue_number: prNumber, // PRs are also issues in GitHub API
          body: `Linked to #${issueNumber}`,
        }),
      `link PR #${prNumber} to issue #${issueNumber}`
    );
  }

  /**
   * Get all PRs linked to an issue
   * Uses GitHub's timeline events to find linked PRs
   */
  async getLinkedToIssue(issueNumber: number): Promise<PullRequest[]> {
    // First approach: Search for PRs that mention the issue
    const { data: searchResults } = await this.client.request(
      () =>
        this.client.rest.search.issuesAndPullRequests({
          q: `repo:${this.client.owner}/${this.client.repo} is:pr #${issueNumber}`,
          per_page: 100,
        }),
      `search PRs linked to issue #${issueNumber}`
    );

    const pullRequests: PullRequest[] = [];

    for (const item of searchResults.items) {
      // Verify it's a PR and links to this issue
      if ('pull_request' in item) {
        const pr = await this.get(item.number);
        if (pr.linkedIssues.includes(issueNumber)) {
          pullRequests.push(pr);
        }
      }
    }

    // Second approach: Check timeline events for cross-references
    const { data: timeline } = await this.client.request(
      () =>
        this.client.rest.issues.listEventsForTimeline({
          owner: this.client.owner,
          repo: this.client.repo,
          issue_number: issueNumber,
          per_page: 100,
        }),
      `get timeline for issue #${issueNumber}`
    );

    // Find cross-referenced PRs
    for (const event of timeline) {
      if (
        event.event === 'cross-referenced' &&
        'source' in event &&
        event.source &&
        typeof event.source === 'object' &&
        'issue' in event.source
      ) {
        const source = event.source as { issue?: { number: number; pull_request?: unknown } };
        if (source.issue?.pull_request) {
          const prNumber = source.issue.number;
          // Avoid duplicates
          if (!pullRequests.some((pr) => pr.number === prNumber)) {
            const pr = await this.get(prNumber);
            pullRequests.push(pr);
          }
        }
      }
    }

    return pullRequests;
  }

  /**
   * List all open PRs in the repository
   */
  async listOpen(): Promise<PullRequest[]> {
    const results = await this.client.paginate(
      (params) =>
        this.client.rest.pulls.list({
          owner: this.client.owner,
          repo: this.client.repo,
          state: 'open',
          ...params,
        }),
      10
    );

    return results.map(transformPullRequest);
  }

  /**
   * List PRs by author
   */
  async listByAuthor(authorLogin: string): Promise<PullRequest[]> {
    const { data } = await this.client.request(
      () =>
        this.client.rest.search.issuesAndPullRequests({
          q: `repo:${this.client.owner}/${this.client.repo} is:pr author:${authorLogin}`,
          per_page: 100,
        }),
      `search PRs by author ${authorLogin}`
    );

    return Promise.all(
      data.items
        .filter((item) => 'pull_request' in item)
        .map((item) => this.get(item.number))
    );
  }

  /**
   * Check if an issue has any linked PRs
   */
  async hasLinkedPRs(issueNumber: number): Promise<boolean> {
    const linkedPRs = await this.getLinkedToIssue(issueNumber);
    return linkedPRs.length > 0;
  }
}

/**
 * Create pull request operations instance
 */
export function createPullRequestOperations(client: GitHubClient): PullRequestOperations {
  return new PullRequestOperations(client);
}
