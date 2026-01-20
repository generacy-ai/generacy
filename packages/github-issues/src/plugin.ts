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
 * Provides programmatic access to GitHub Issues functionality including:
 * - Issue CRUD operations
 * - Label management
 * - Comment handling
 * - PR linking
 * - Webhook event processing
 */
export class GitHubIssuesPlugin {
  private readonly client: GitHubClient;
  private readonly issues: IssueOperations;
  private readonly labels: LabelOperations;
  private readonly comments: CommentOperations;
  private readonly pullRequests: PullRequestOperations;
  private readonly webhookHandler: WebhookHandler;

  constructor(config: GitHubIssuesConfig) {
    this.client = createClient(config);
    this.issues = createIssueOperations(this.client);
    this.labels = createLabelOperations(this.client);
    this.comments = createCommentOperations(this.client);
    this.pullRequests = createPullRequestOperations(this.client);

    const webhookConfig: WebhookHandlerConfig = {
      webhookSecret: config.webhookSecret,
      agentAccount: config.agentAccount,
      triggerLabels: config.triggerLabels,
    };
    this.webhookHandler = createWebhookHandler(webhookConfig);
  }

  // ==================== Issue Operations ====================

  /**
   * Create a new issue
   */
  async createIssue(params: CreateIssueParams): Promise<Issue> {
    return this.issues.create(params);
  }

  /**
   * Get an issue by number
   */
  async getIssue(number: number): Promise<Issue> {
    return this.issues.get(number);
  }

  /**
   * Update an issue
   */
  async updateIssue(number: number, params: UpdateIssueParams): Promise<Issue> {
    return this.issues.update(number, params);
  }

  /**
   * Close an issue
   */
  async closeIssue(number: number): Promise<void> {
    return this.issues.close(number);
  }

  /**
   * Search issues using GitHub search syntax
   */
  async searchIssues(query: string): Promise<Issue[]> {
    return this.issues.search(query);
  }

  /**
   * List issues with optional filtering
   */
  async listIssues(filter?: IssueFilter): Promise<Issue[]> {
    return this.issues.list(filter);
  }

  // ==================== Label Operations ====================

  /**
   * Add labels to an issue
   */
  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.labels.add(issueNumber, labels);
  }

  /**
   * Remove labels from an issue
   */
  async removeLabels(issueNumber: number, labels: string[]): Promise<void> {
    await this.labels.removeMany(issueNumber, labels);
  }

  /**
   * Set labels on an issue (replaces existing)
   */
  async setLabels(issueNumber: number, labels: string[]): Promise<Label[]> {
    return this.labels.set(issueNumber, labels);
  }

  /**
   * List labels on an issue
   */
  async listLabels(issueNumber: number): Promise<Label[]> {
    return this.labels.list(issueNumber);
  }

  // ==================== Comment Operations ====================

  /**
   * Add a comment to an issue
   */
  async addComment(issueNumber: number, body: string): Promise<Comment> {
    return this.comments.add(issueNumber, body);
  }

  /**
   * List comments on an issue
   */
  async listComments(issueNumber: number): Promise<Comment[]> {
    return this.comments.list(issueNumber);
  }

  /**
   * Update a comment
   */
  async updateComment(commentId: number, body: string): Promise<Comment> {
    return this.comments.update(commentId, body);
  }

  /**
   * Delete a comment
   */
  async deleteComment(commentId: number): Promise<void> {
    return this.comments.delete(commentId);
  }

  // ==================== Pull Request Operations ====================

  /**
   * Link a pull request to an issue
   */
  async linkPullRequest(issueNumber: number, prNumber: number): Promise<void> {
    return this.pullRequests.linkToIssue(prNumber, issueNumber);
  }

  /**
   * Get pull requests linked to an issue
   */
  async getLinkedPRs(issueNumber: number): Promise<PullRequest[]> {
    return this.pullRequests.getLinkedToIssue(issueNumber);
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
      issues: this.issues,
      labels: this.labels,
      comments: this.comments,
      pullRequests: this.pullRequests,
    };
  }

  /**
   * Access to webhook handler for advanced usage
   */
  get webhook(): WebhookHandler {
    return this.webhookHandler;
  }
}

/**
 * Create a new GitHub Issues plugin instance
 */
export function createPlugin(config: GitHubIssuesConfig): GitHubIssuesPlugin {
  return new GitHubIssuesPlugin(config);
}
