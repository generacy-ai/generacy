import type { JiraClient } from '../client.js';
import type { JiraComment, AddCommentParams, CommentVisibility, AdfDocument } from '../types/events.js';
import { ensureIssueKey } from '../utils/validation.js';
import { wrapJiraError, JiraNotFoundError } from '../utils/errors.js';
import { ensureAdf } from '../utils/adf.js';

/**
 * Map API response to JiraComment
 */
function mapComment(raw: Record<string, unknown>): JiraComment {
  return {
    id: raw.id as string,
    self: raw.self as string,
    author: raw.author as JiraComment['author'],
    body: raw.body as AdfDocument,
    created: raw.created as string,
    updated: raw.updated as string,
    visibility: (raw.visibility as CommentVisibility) ?? null,
  };
}

/**
 * Comment operations
 */
export class CommentOperations {
  constructor(private readonly client: JiraClient) {}

  /**
   * Add a comment to an issue
   */
  async add(issueKey: string, body: string | AdfDocument): Promise<JiraComment>;
  async add(issueKey: string, params: AddCommentParams): Promise<JiraComment>;
  async add(issueKey: string, bodyOrParams: string | AdfDocument | AddCommentParams): Promise<JiraComment> {
    const key = ensureIssueKey(issueKey);

    let body: AdfDocument;
    let visibility: CommentVisibility | undefined;

    if (typeof bodyOrParams === 'string') {
      body = ensureAdf(bodyOrParams);
    } else if ('version' in bodyOrParams && bodyOrParams.version === 1) {
      body = bodyOrParams;
    } else {
      const params = bodyOrParams as AddCommentParams;
      body = ensureAdf(params.body);
      visibility = params.visibility;
    }

    try {
      const response = await this.client.v3.issueComments.addComment({
        issueIdOrKey: key,
        comment: body as Parameters<typeof this.client.v3.issueComments.addComment>[0]['comment'],
        visibility: visibility as Parameters<typeof this.client.v3.issueComments.addComment>[0]['visibility'],
      });
      return mapComment(response as unknown as Record<string, unknown>);
    } catch (error) {
      throw wrapJiraError(error, `Failed to add comment to ${key}`);
    }
  }

  /**
   * Get all comments for an issue
   */
  async list(issueKey: string): Promise<JiraComment[]> {
    const key = ensureIssueKey(issueKey);

    try {
      const response = await this.client.v3.issueComments.getComments({
        issueIdOrKey: key,
        orderBy: '-created',
      });
      return (response.comments ?? []).map((c) => mapComment(c as unknown as Record<string, unknown>));
    } catch (error) {
      throw wrapJiraError(error, `Failed to get comments for ${key}`);
    }
  }

  /**
   * Get a specific comment by ID
   */
  async get(issueKey: string, commentId: string): Promise<JiraComment> {
    const key = ensureIssueKey(issueKey);

    try {
      const response = await this.client.v3.issueComments.getComment({
        issueIdOrKey: key,
        id: commentId,
      });
      return mapComment(response as unknown as Record<string, unknown>);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'status' in error && (error as { status: number }).status === 404) {
        throw new JiraNotFoundError('Comment', commentId, error);
      }
      throw wrapJiraError(error, `Failed to get comment ${commentId}`);
    }
  }

  /**
   * Update a comment
   */
  async update(issueKey: string, commentId: string, body: string | AdfDocument): Promise<JiraComment> {
    const key = ensureIssueKey(issueKey);
    const adfBody = ensureAdf(body);

    try {
      const response = await this.client.v3.issueComments.updateComment({
        issueIdOrKey: key,
        id: commentId,
        body: adfBody,
      });
      return mapComment(response as unknown as Record<string, unknown>);
    } catch (error) {
      throw wrapJiraError(error, `Failed to update comment ${commentId}`);
    }
  }

  /**
   * Delete a comment
   */
  async delete(issueKey: string, commentId: string): Promise<void> {
    const key = ensureIssueKey(issueKey);

    try {
      await this.client.v3.issueComments.deleteComment({
        issueIdOrKey: key,
        id: commentId,
      });
    } catch (error) {
      throw wrapJiraError(error, `Failed to delete comment ${commentId}`);
    }
  }
}

/**
 * Create comment operations instance
 */
export function createCommentOperations(client: JiraClient): CommentOperations {
  return new CommentOperations(client);
}
