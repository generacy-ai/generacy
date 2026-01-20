import type { GitHubClient } from '../client.js';
import type { Comment, User } from '../types/index.js';
import { GitHubValidationError } from '../utils/errors.js';

/**
 * Transform GitHub API comment response to our Comment type
 */
function transformComment(apiComment: {
  id: number;
  body?: string;
  user: { id: number; login: string; avatar_url: string; type?: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}): Comment {
  return {
    id: apiComment.id,
    body: apiComment.body ?? '',
    author: apiComment.user
      ? {
          id: apiComment.user.id,
          login: apiComment.user.login,
          avatarUrl: apiComment.user.avatar_url,
          type: (apiComment.user.type ?? 'User') as User['type'],
        }
      : { id: 0, login: 'unknown', avatarUrl: '', type: 'User' },
    createdAt: apiComment.created_at,
    updatedAt: apiComment.updated_at,
    htmlUrl: apiComment.html_url,
  };
}

/**
 * Comment operations using the GitHub client
 */
export class CommentOperations {
  constructor(private readonly client: GitHubClient) {}

  /**
   * Add a comment to an issue
   */
  async add(issueNumber: number, body: string): Promise<Comment> {
    if (!body.trim()) {
      throw new GitHubValidationError('Comment body cannot be empty');
    }

    const { data } = await this.client.request(
      () =>
        this.client.rest.issues.createComment({
          owner: this.client.owner,
          repo: this.client.repo,
          issue_number: issueNumber,
          body,
        }),
      `add comment to issue #${issueNumber}`
    );

    return transformComment(data);
  }

  /**
   * Update an existing comment
   */
  async update(commentId: number, body: string): Promise<Comment> {
    if (!body.trim()) {
      throw new GitHubValidationError('Comment body cannot be empty');
    }

    const { data } = await this.client.request(
      () =>
        this.client.rest.issues.updateComment({
          owner: this.client.owner,
          repo: this.client.repo,
          comment_id: commentId,
          body,
        }),
      `update comment #${commentId}`
    );

    return transformComment(data);
  }

  /**
   * Delete a comment
   */
  async delete(commentId: number): Promise<void> {
    await this.client.request(
      () =>
        this.client.rest.issues.deleteComment({
          owner: this.client.owner,
          repo: this.client.repo,
          comment_id: commentId,
        }),
      `delete comment #${commentId}`
    );
  }

  /**
   * Get a single comment by ID
   */
  async get(commentId: number): Promise<Comment> {
    const { data } = await this.client.request(
      () =>
        this.client.rest.issues.getComment({
          owner: this.client.owner,
          repo: this.client.repo,
          comment_id: commentId,
        }),
      `get comment #${commentId}`
    );

    return transformComment(data);
  }

  /**
   * List all comments on an issue
   */
  async list(issueNumber: number): Promise<Comment[]> {
    const results = await this.client.paginate(
      (params) =>
        this.client.rest.issues.listComments({
          owner: this.client.owner,
          repo: this.client.repo,
          issue_number: issueNumber,
          ...params,
        }),
      10
    );

    return results.map(transformComment);
  }

  /**
   * List comments on an issue since a specific date
   */
  async listSince(issueNumber: number, since: Date): Promise<Comment[]> {
    const results = await this.client.paginate(
      (params) =>
        this.client.rest.issues.listComments({
          owner: this.client.owner,
          repo: this.client.repo,
          issue_number: issueNumber,
          since: since.toISOString(),
          ...params,
        }),
      10
    );

    return results.map(transformComment);
  }

  /**
   * Find comments by author
   */
  async findByAuthor(issueNumber: number, authorLogin: string): Promise<Comment[]> {
    const allComments = await this.list(issueNumber);
    return allComments.filter((comment) => comment.author.login === authorLogin);
  }

  /**
   * Find comments matching a pattern
   */
  async findByPattern(issueNumber: number, pattern: RegExp): Promise<Comment[]> {
    const allComments = await this.list(issueNumber);
    return allComments.filter((comment) => pattern.test(comment.body));
  }
}

/**
 * Create comment operations instance
 */
export function createCommentOperations(client: GitHubClient): CommentOperations {
  return new CommentOperations(client);
}
