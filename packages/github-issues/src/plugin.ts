import type {
  Issue as LatencyIssue,
  IssueSpec as LatencyIssueSpec,
  IssueUpdate as LatencyIssueUpdate,
  IssueQuery as LatencyIssueQuery,
  Comment as LatencyComment,
  PaginatedResult,
} from '@generacy-ai/latency';
import { AbstractIssueTrackerPlugin } from '@generacy-ai/latency-plugin-issue-tracker';
import type {
  GitHubIssuesConfig,
  Issue,
  CreateIssueParams,
  UpdateIssueParams,
  IssueFilter,
  Label,
  Comment,
  PullRequest,
  WorkflowAction,
  TypedWebhookEvent,
} from './types/index.js';
import { GitHubClient, createClient } from './client.js';
import { IssueOperations, createIssueOperations } from './operations/issues.js';
import { LabelOperations, createLabelOperations } from './operations/labels.js';
import { CommentOperations, createCommentOperations } from './operations/comments.js';
import { PullRequestOperations, createPullRequestOperations } from './operations/pull-requests.js';
import { WebhookHandler, createWebhookHandler, type WebhookHandlerConfig } from './webhooks/handler.js';

/**
 * GitHub Issues Plugin for Generacy
 *
 * Extends AbstractIssueTrackerPlugin to provide the standard IssueTracker interface
 * while also exposing GitHub-specific functionality.
 *
 * Provides programmatic access to GitHub Issues functionality including:
 * - Issue CRUD operations (via IssueTracker interface)
 * - Label management
 * - Comment handling
 * - PR linking
 * - Webhook event processing
 */
export class GitHubIssuesPlugin extends AbstractIssueTrackerPlugin {
  private readonly client: GitHubClient;
  private readonly issueOps: IssueOperations;
  private readonly labelOps: LabelOperations;
  private readonly commentOps: CommentOperations;
  private readonly pullRequestOps: PullRequestOperations;
  private readonly webhookHandler: WebhookHandler;

  constructor(config: GitHubIssuesConfig) {
    super({ cacheTimeout: config.cacheTimeout ?? 60000 });
    this.client = createClient(config);
    this.issueOps = createIssueOperations(this.client);
    this.labelOps = createLabelOperations(this.client);
    this.commentOps = createCommentOperations(this.client);
    this.pullRequestOps = createPullRequestOperations(this.client);

    const webhookConfig: WebhookHandlerConfig = {
      webhookSecret: config.webhookSecret,
      agentAccount: config.agentAccount,
      triggerLabels: config.triggerLabels,
    };
    this.webhookHandler = createWebhookHandler(webhookConfig);
  }

  // ==========================================================================
  // AbstractIssueTrackerPlugin abstract method implementations
  // ==========================================================================

  /**
   * Fetch a single issue from GitHub (implements abstract method)
   */
  protected async fetchIssue(id: string): Promise<LatencyIssue> {
    const issueNumber = this.parseIssueNumber(id);
    const issue = await this.issueOps.get(issueNumber);
    return this.mapToLatencyIssue(issue);
  }

  /**
   * Create a new issue in GitHub (implements abstract method)
   */
  protected async doCreateIssue(spec: LatencyIssueSpec): Promise<LatencyIssue> {
    const params: CreateIssueParams = {
      title: spec.title,
      body: spec.body,
      labels: spec.labels,
      assignees: spec.assignees,
    };
    const issue = await this.issueOps.create(params);
    return this.mapToLatencyIssue(issue);
  }

  /**
   * Update an existing issue (implements abstract method)
   */
  protected async doUpdateIssue(id: string, update: LatencyIssueUpdate): Promise<LatencyIssue> {
    const issueNumber = this.parseIssueNumber(id);
    const params: UpdateIssueParams = {
      title: update.title,
      body: update.body,
      state: update.state,
      labels: update.labels,
      assignees: update.assignees,
    };
    const issue = await this.issueOps.update(issueNumber, params);
    return this.mapToLatencyIssue(issue);
  }

  /**
   * List issues matching the query (implements abstract method)
   */
  protected async doListIssues(query: LatencyIssueQuery): Promise<PaginatedResult<LatencyIssue>> {
    const filter: IssueFilter = {
      state: query.state,
      labels: query.labels,
      assignee: query.assignee,
    };

    const issues = await this.issueOps.list(filter);
    const latencyIssues = issues.map((issue) => this.mapToLatencyIssue(issue));

    // Apply pagination manually since the underlying operation returns all
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 30;
    const paginatedItems = latencyIssues.slice(offset, offset + limit);

    return {
      items: paginatedItems,
      total: latencyIssues.length,
      hasMore: offset + limit < latencyIssues.length,
    };
  }

  /**
   * Add a comment to an issue (implements abstract method)
   */
  protected async doAddComment(issueId: string, comment: string): Promise<LatencyComment> {
    const issueNumber = this.parseIssueNumber(issueId);
    const ghComment = await this.commentOps.add(issueNumber, comment);
    return this.mapToLatencyComment(ghComment);
  }

  /**
   * List comments for an issue (implements abstract method)
   */
  protected async doListComments(issueId: string): Promise<LatencyComment[]> {
    const issueNumber = this.parseIssueNumber(issueId);
    const comments = await this.commentOps.list(issueNumber);
    return comments.map((c) => this.mapToLatencyComment(c));
  }

  // ==========================================================================
  // GitHub-specific public API (for backwards compatibility)
  // ==========================================================================

  /**
   * Create a new issue (GitHub-specific version with full return type)
   */
  async createGitHubIssue(params: CreateIssueParams): Promise<Issue> {
    return this.issueOps.create(params);
  }

  /**
   * Get an issue by number (GitHub-specific version with full return type)
   */
  async getGitHubIssue(number: number): Promise<Issue> {
    return this.issueOps.get(number);
  }

  /**
   * Update an issue (GitHub-specific version)
   */
  async updateGitHubIssue(number: number, params: UpdateIssueParams): Promise<Issue> {
    return this.issueOps.update(number, params);
  }

  /**
   * Close an issue
   */
  async closeIssue(number: number): Promise<void> {
    return this.issueOps.close(number);
  }

  /**
   * Search issues using GitHub search syntax
   */
  async searchIssues(query: string): Promise<Issue[]> {
    return this.issueOps.search(query);
  }

  /**
   * List issues with optional filtering (GitHub-specific version)
   */
  async listGitHubIssues(filter?: IssueFilter): Promise<Issue[]> {
    return this.issueOps.list(filter);
  }

  // ==================== Label Operations ====================

  /**
   * Add labels to an issue
   */
  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.labelOps.add(issueNumber, labels);
  }

  /**
   * Remove labels from an issue
   */
  async removeLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.labelOps.removeMany(issueNumber, labels);
  }

  /**
   * Set labels on an issue (replaces existing)
   */
  async setLabels(issueNumber: number, labels: string[]): Promise<Label[]> {
    return this.labelOps.set(issueNumber, labels);
  }

  /**
   * List labels on an issue
   */
  async listLabels(issueNumber: number): Promise<Label[]> {
    return this.labelOps.list(issueNumber);
  }

  // ==================== Comment Operations (GitHub-specific) ====================

  /**
   * Add a comment to an issue (GitHub-specific version with full return type)
   */
  async addGitHubComment(issueNumber: number, body: string): Promise<Comment> {
    return this.commentOps.add(issueNumber, body);
  }

  /**
   * List comments on an issue (GitHub-specific version with numeric issue number)
   */
  async listGitHubComments(issueNumber: number): Promise<Comment[]> {
    return this.commentOps.list(issueNumber);
  }

  /**
   * Update a comment
   */
  async updateComment(commentId: number, body: string): Promise<Comment> {
    return this.commentOps.update(commentId, body);
  }

  /**
   * Delete a comment
   */
  async deleteComment(commentId: number): Promise<void> {
    return this.commentOps.delete(commentId);
  }

  // ==================== Pull Request Operations ====================

  /**
   * Link a pull request to an issue
   */
  async linkPullRequest(issueNumber: number, prNumber: number): Promise<void> {
    return this.pullRequestOps.linkToIssue(prNumber, issueNumber);
  }

  /**
   * Get pull requests linked to an issue
   */
  async getLinkedPRs(issueNumber: number): Promise<PullRequest[]> {
    return this.pullRequestOps.getLinkedToIssue(issueNumber);
  }

  // ==================== Webhook Operations ====================

  /**
   * Handle a webhook event
   * Returns the workflow action to take based on the event
   */
  async handleWebhook(event: TypedWebhookEvent): Promise<WorkflowAction> {
    const result = await this.webhookHandler.processEvent(event);
    return result.action;
  }

  /**
   * Handle a raw webhook delivery
   * Useful when receiving webhooks directly from GitHub
   */
  async handleRawWebhook(
    eventName: string,
    payload: unknown,
    deliveryId?: string
  ): Promise<WorkflowAction> {
    return this.webhookHandler.handle(eventName, payload, deliveryId);
  }

  // ==================== Utility Methods ====================

  /**
   * Verify authentication
   */
  async verifyAuth(): Promise<{ login: string; id: number }> {
    return this.client.verifyAuth();
  }

  /**
   * Get current rate limit status
   */
  async getRateLimit(): Promise<{
    limit: number;
    remaining: number;
    reset: Date;
  }> {
    return this.client.getRateLimit();
  }

  /**
   * Get the repository owner
   */
  get owner(): string {
    return this.client.owner;
  }

  /**
   * Get the repository name
   */
  get repo(): string {
    return this.client.repo;
  }

  /**
   * Access to underlying operations for advanced usage
   */
  get operations(): {
    issues: IssueOperations;
    labels: LabelOperations;
    comments: CommentOperations;
    pullRequests: PullRequestOperations;
  } {
    return {
      issues: this.issueOps,
      labels: this.labelOps,
      comments: this.commentOps,
      pullRequests: this.pullRequestOps,
    };
  }

  /**
   * Access to webhook handler for advanced usage
   */
  get webhook(): WebhookHandler {
    return this.webhookHandler;
  }

  // ==========================================================================
  // Private helper methods
  // ==========================================================================

  /**
   * Parse an issue ID string to a number
   */
  private parseIssueNumber(id: string): number {
    const num = parseInt(id, 10);
    if (isNaN(num) || num <= 0) {
      throw new Error(`Invalid issue number: ${id}`);
    }
    return num;
  }

  /**
   * Map a GitHub Issue to the Latency Issue type
   */
  private mapToLatencyIssue(issue: Issue): LatencyIssue {
    return {
      id: String(issue.number),
      title: issue.title,
      body: issue.body ?? '',
      state: issue.state,
      labels: issue.labels.map((label) => label.name),
      assignees: issue.assignees.map((user) => user.login),
      createdAt: new Date(issue.createdAt),
      updatedAt: new Date(issue.updatedAt),
    };
  }

  /**
   * Map a GitHub Comment to the Latency Comment type
   */
  private mapToLatencyComment(comment: Comment): LatencyComment {
    return {
      id: String(comment.id),
      body: comment.body,
      author: comment.author.login,
      createdAt: new Date(comment.createdAt),
    };
  }
}

/**
 * Create a new GitHub Issues plugin instance
 */
export function createPlugin(config: GitHubIssuesConfig): GitHubIssuesPlugin {
  return new GitHubIssuesPlugin(config);
}
