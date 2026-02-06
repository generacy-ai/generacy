/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * GitHub API client wrapper using Octokit.
 */

import { Octokit } from '@octokit/rest';
import { GitHubAPIError } from '../errors.js';
import type {
  GitHubClientConfig,
  GitHubIssue,
  GitHubPullRequest,
  GitHubPRFile,
  GitHubReview,
  ParsedIssueUrl,
} from './types.js';

const GITHUB_ISSUE_URL_REGEX = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;

/**
 * Parse a GitHub issue URL into its components.
 */
export function parseIssueUrl(url: string): ParsedIssueUrl {
  const match = url.match(GITHUB_ISSUE_URL_REGEX);
  if (!match) {
    throw new GitHubAPIError(`Invalid GitHub issue URL format: ${url}`);
  }
  return {
    owner: match[1]!,
    repo: match[2]!,
    issueNumber: parseInt(match[3]!, 10),
  };
}

/**
 * GitHub API client for issue and PR operations.
 */
export class GitHubClient {
  private readonly octokit: Octokit;

  constructor(config: GitHubClientConfig) {
    this.octokit = new Octokit({
      auth: config.token,
      baseUrl: config.baseUrl,
    });
  }

  /**
   * Get an issue by owner/repo/number.
   */
  async getIssue(owner: string, repo: string, issueNumber: number): Promise<GitHubIssue> {
    try {
      const response = await this.octokit.issues.get({
        owner,
        repo,
        issue_number: issueNumber,
      });
      return response.data as GitHubIssue;
    } catch (error) {
      throw this.wrapOctokitError(error, `GET /repos/${owner}/${repo}/issues/${issueNumber}`);
    }
  }

  /**
   * List pull requests linked to an issue.
   */
  async listLinkedPullRequests(
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<GitHubPullRequest[]> {
    try {
      // Search for PRs that mention this issue
      const searchQuery = `repo:${owner}/${repo} is:pr ${issueNumber}`;
      const response = await this.octokit.search.issuesAndPullRequests({
        q: searchQuery,
        per_page: 10,
      });

      // Filter to PRs that explicitly link to this issue
      const linkedPRs: GitHubPullRequest[] = [];
      for (const item of response.data.items) {
        if (item.pull_request) {
          const pr = await this.getPullRequest(owner, repo, item.number);
          // Check if PR body references the issue
          if (
            pr.body?.includes(`#${issueNumber}`) ||
            pr.body?.includes(`issues/${issueNumber}`)
          ) {
            linkedPRs.push(pr);
          }
        }
      }

      return linkedPRs;
    } catch (error) {
      throw this.wrapOctokitError(error, `search PRs for issue ${issueNumber}`);
    }
  }

  /**
   * Get a pull request by owner/repo/number.
   */
  async getPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<GitHubPullRequest> {
    try {
      const response = await this.octokit.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      });
      return response.data as GitHubPullRequest;
    } catch (error) {
      throw this.wrapOctokitError(error, `GET /repos/${owner}/${repo}/pulls/${prNumber}`);
    }
  }

  /**
   * Get files changed in a pull request.
   */
  async getPullRequestFiles(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<GitHubPRFile[]> {
    try {
      const response = await this.octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      return response.data as GitHubPRFile[];
    } catch (error) {
      throw this.wrapOctokitError(error, `GET /repos/${owner}/${repo}/pulls/${prNumber}/files`);
    }
  }

  /**
   * Get reviews for a pull request.
   */
  async getPullRequestReviews(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<GitHubReview[]> {
    try {
      const response = await this.octokit.pulls.listReviews({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      return response.data as GitHubReview[];
    } catch (error) {
      throw this.wrapOctokitError(error, `GET /repos/${owner}/${repo}/pulls/${prNumber}/reviews`);
    }
  }

  /**
   * Get file content from a repository.
   */
  async getFileContent(owner: string, repo: string, path: string, ref?: string): Promise<string> {
    try {
      const response = await this.octokit.repos.getContent({
        owner,
        repo,
        path,
        ref,
      });

      const data = response.data;
      if ('content' in data && data.encoding === 'base64') {
        return Buffer.from(data.content, 'base64').toString('utf-8');
      }
      throw new GitHubAPIError(`Unexpected response format for file content: ${path}`);
    } catch (error) {
      if (error instanceof GitHubAPIError) throw error;
      throw this.wrapOctokitError(error, `GET /repos/${owner}/${repo}/contents/${path}`);
    }
  }

  /**
   * Convert Octokit errors to GitHubAPIError.
   */
  private wrapOctokitError(error: unknown, endpoint: string): GitHubAPIError {
    if (error instanceof GitHubAPIError) {
      return error;
    }

    const octokitError = error as { status?: number; message?: string };
    const statusCode = octokitError.status;
    const message = octokitError.message ?? 'Unknown GitHub API error';

    return new GitHubAPIError(message, statusCode, endpoint);
  }
}
