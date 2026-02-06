import type {
  JiraConfig,
  JiraIssue,
  CreateJiraIssueParams,
  UpdateJiraIssueParams,
  SearchOptions,
  JiraComment,
  AddCommentParams,
  Transition,
  TransitionParams,
  CustomField,
  Sprint,
  Board,
  AdfDocument,
} from './types/index.js';
import { JiraClient, createClient } from './client.js';
import { IssueOperations, createIssueOperations } from './operations/issues.js';
import { SearchOperations, createSearchOperations } from './operations/search.js';
import { CommentOperations, createCommentOperations } from './operations/comments.js';
import { TransitionOperations, createTransitionOperations } from './operations/transitions.js';
import { CustomFieldOperations, createCustomFieldOperations } from './operations/custom-fields.js';
import { SprintOperations, createSprintOperations } from './operations/sprints.js';
import {
  JiraWebhookHandler,
  createWebhookHandler,
  type JiraWebhookHandlerConfig,
} from './webhooks/handler.js';
import type { JiraWebhookEvent, WebhookAction } from './webhooks/types.js';

/**
 * Jira Plugin for Generacy
 *
 * Provides programmatic access to Jira functionality including:
 * - Issue CRUD operations
 * - JQL search with async iteration
 * - Workflow transitions
 * - Custom field management
 * - Sprint operations
 * - Webhook event processing
 */
export class JiraPlugin {
  private readonly client: JiraClient;
  private readonly issueOps: IssueOperations;
  private readonly searchOps: SearchOperations;
  private readonly commentOps: CommentOperations;
  private readonly transitionOps: TransitionOperations;
  private readonly customFieldOps: CustomFieldOperations;
  private readonly sprintOps: SprintOperations;
  private readonly webhookHandler: JiraWebhookHandler;

  constructor(config: JiraConfig) {
    this.client = createClient(config);
    this.issueOps = createIssueOperations(this.client);
    this.searchOps = createSearchOperations(this.client);
    this.commentOps = createCommentOperations(this.client);
    this.transitionOps = createTransitionOperations(this.client);
    this.customFieldOps = createCustomFieldOperations(this.client);
    this.sprintOps = createSprintOperations(this.client);

    const webhookConfig: JiraWebhookHandlerConfig = {
      webhookSecret: config.webhookSecret,
    };
    this.webhookHandler = createWebhookHandler(webhookConfig);
  }

  // ==================== Issue Operations ====================

  /**
   * Create a new issue
   */
  async createIssue(params: CreateJiraIssueParams): Promise<JiraIssue> {
    return this.issueOps.create(params);
  }

  /**
   * Get an issue by key or ID
   */
  async getIssue(keyOrId: string): Promise<JiraIssue> {
    return this.issueOps.get(keyOrId);
  }

  /**
   * Update an issue
   */
  async updateIssue(keyOrId: string, params: UpdateJiraIssueParams): Promise<JiraIssue> {
    return this.issueOps.update(keyOrId, params);
  }

  /**
   * Delete an issue
   */
  async deleteIssue(keyOrId: string, deleteSubtasks = false): Promise<void> {
    return this.issueOps.delete(keyOrId, deleteSubtasks);
  }

  /**
   * Assign an issue to a user
   */
  async assignIssue(keyOrId: string, accountId: string | null): Promise<void> {
    return this.issueOps.assign(keyOrId, accountId);
  }

  // ==================== Search Operations ====================

  /**
   * Search issues using JQL (returns async iterator)
   */
  searchIssues(jql: string, options?: SearchOptions): AsyncGenerator<JiraIssue> {
    return this.searchOps.search(jql, options);
  }

  /**
   * Search issues and return all results as array
   */
  async searchIssuesAll(jql: string, options?: SearchOptions): Promise<JiraIssue[]> {
    return this.searchOps.searchAll(jql, options);
  }

  /**
   * Count issues matching a JQL query
   */
  async countIssues(jql: string): Promise<number> {
    return this.searchOps.count(jql);
  }

  // ==================== Comment Operations ====================

  /**
   * Add a comment to an issue
   */
  async addComment(issueKey: string, body: string | AdfDocument): Promise<JiraComment>;
  async addComment(issueKey: string, params: AddCommentParams): Promise<JiraComment>;
  async addComment(
    issueKey: string,
    bodyOrParams: string | AdfDocument | AddCommentParams
  ): Promise<JiraComment> {
    if (typeof bodyOrParams === 'string' || ('version' in bodyOrParams && bodyOrParams.version === 1)) {
      return this.commentOps.add(issueKey, bodyOrParams as string | AdfDocument);
    }
    return this.commentOps.add(issueKey, bodyOrParams as AddCommentParams);
  }

  /**
   * Get all comments for an issue
   */
  async getComments(issueKey: string): Promise<JiraComment[]> {
    return this.commentOps.list(issueKey);
  }

  /**
   * Update a comment
   */
  async updateComment(
    issueKey: string,
    commentId: string,
    body: string | AdfDocument
  ): Promise<JiraComment> {
    return this.commentOps.update(issueKey, commentId, body);
  }

  /**
   * Delete a comment
   */
  async deleteComment(issueKey: string, commentId: string): Promise<void> {
    return this.commentOps.delete(issueKey, commentId);
  }

  // ==================== Transition Operations ====================

  /**
   * Get available transitions for an issue
   */
  async getTransitions(issueKey: string): Promise<Transition[]> {
    return this.transitionOps.getTransitions(issueKey);
  }

  /**
   * Transition an issue
   */
  async transitionIssue(issueKey: string, transitionId: string, options?: { fields?: Record<string, unknown>; comment?: string }): Promise<void>;
  async transitionIssue(issueKey: string, params: TransitionParams): Promise<void>;
  async transitionIssue(
    issueKey: string,
    transitionIdOrParams: string | TransitionParams,
    options?: { fields?: Record<string, unknown>; comment?: string }
  ): Promise<void> {
    if (typeof transitionIdOrParams === 'string') {
      return this.transitionOps.transition(issueKey, transitionIdOrParams, options);
    }
    return this.transitionOps.transition(issueKey, transitionIdOrParams);
  }

  /**
   * Transition an issue to a specific status by name
   */
  async transitionToStatus(
    issueKey: string,
    statusName: string,
    options?: { fields?: Record<string, unknown>; comment?: string }
  ): Promise<void> {
    return this.transitionOps.transitionToStatus(issueKey, statusName, options);
  }

  // ==================== Custom Field Operations ====================

  /**
   * Get all custom fields
   */
  async getCustomFields(): Promise<CustomField[]> {
    return this.customFieldOps.getAll();
  }

  /**
   * Get a custom field by ID
   */
  async getCustomField(fieldId: string): Promise<CustomField> {
    return this.customFieldOps.get(fieldId);
  }

  /**
   * Set a custom field value
   */
  async setCustomField(issueKey: string, fieldId: string, value: unknown): Promise<void> {
    return this.customFieldOps.setValue(issueKey, fieldId, value);
  }

  // ==================== Sprint Operations ====================

  /**
   * Get the active sprint for a board
   */
  async getActiveSprint(boardId: number): Promise<Sprint | null> {
    return this.sprintOps.getActiveSprint(boardId);
  }

  /**
   * Get all sprints for a board
   */
  async getSprintsForBoard(boardId: number): Promise<Sprint[]> {
    return this.sprintOps.getSprintsForBoard(boardId);
  }

  /**
   * Add an issue to a sprint
   */
  async addToSprint(issueKey: string, sprintId: number): Promise<void> {
    return this.sprintOps.addIssueToSprint(issueKey, sprintId);
  }

  /**
   * Get boards for a project
   */
  async getBoardsForProject(projectKey: string): Promise<Board[]> {
    return this.sprintOps.getBoardsForProject(projectKey);
  }

  // ==================== Webhook Operations ====================

  /**
   * Handle a webhook event
   * Returns the parsed action from the event
   */
  async handleWebhook(event: JiraWebhookEvent): Promise<WebhookAction> {
    const result = await this.webhookHandler.processEvent(event);
    return result.action;
  }

  /**
   * Handle a raw webhook payload
   */
  async handleRawWebhook(payload: unknown): Promise<WebhookAction> {
    const result = await this.webhookHandler.handle(payload);
    return result.action;
  }

  // ==================== Utility Methods ====================

  /**
   * Verify authentication
   */
  async verifyAuth(): Promise<{ accountId: string; displayName: string; email: string }> {
    return this.client.verifyAuth();
  }

  /**
   * Check connectivity
   */
  async checkConnection(): Promise<{ version: string; baseUrl: string }> {
    return this.client.checkConnection();
  }

  /**
   * Get the Jira host URL
   */
  get host(): string {
    return this.client.host;
  }

  /**
   * Get the default project key
   */
  get projectKey(): string | undefined {
    return this.client.projectKey;
  }

  /**
   * Access to underlying operations for advanced usage
   */
  get operations(): {
    issues: IssueOperations;
    search: SearchOperations;
    comments: CommentOperations;
    transitions: TransitionOperations;
    customFields: CustomFieldOperations;
    sprints: SprintOperations;
  } {
    return {
      issues: this.issueOps,
      search: this.searchOps,
      comments: this.commentOps,
      transitions: this.transitionOps,
      customFields: this.customFieldOps,
      sprints: this.sprintOps,
    };
  }

  /**
   * Access to webhook handler for advanced usage
   */
  get webhook(): JiraWebhookHandler {
    return this.webhookHandler;
  }
}

/**
 * Create a new Jira plugin instance
 */
export function createPlugin(config: JiraConfig): JiraPlugin {
  return new JiraPlugin(config);
}
