import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommentOperations, createCommentOperations } from '../../src/operations/comments.js';
import { JiraClient } from '../../src/client.js';
import { JiraNotFoundError } from '../../src/utils/errors.js';

// Mock the client
vi.mock('../../src/client.js', () => ({
  JiraClient: vi.fn(),
}));

const mockComment = {
  id: '10001',
  self: 'https://company.atlassian.net/rest/api/3/issue/10001/comment/10001',
  author: {
    accountId: 'user-123',
    displayName: 'Test User',
    avatarUrls: {},
  },
  body: {
    version: 1,
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Test comment' }],
      },
    ],
  },
  created: '2024-01-20T10:00:00.000+0000',
  updated: '2024-01-20T10:00:00.000+0000',
  visibility: null,
};

describe('CommentOperations', () => {
  let mockClient: {
    v3: {
      issueComments: {
        addComment: ReturnType<typeof vi.fn>;
        getComments: ReturnType<typeof vi.fn>;
        getComment: ReturnType<typeof vi.fn>;
        updateComment: ReturnType<typeof vi.fn>;
        deleteComment: ReturnType<typeof vi.fn>;
      };
    };
  };
  let operations: CommentOperations;

  beforeEach(() => {
    mockClient = {
      v3: {
        issueComments: {
          addComment: vi.fn(),
          getComments: vi.fn(),
          getComment: vi.fn(),
          updateComment: vi.fn(),
          deleteComment: vi.fn(),
        },
      },
    };
    operations = createCommentOperations(mockClient as unknown as JiraClient);
  });

  describe('add', () => {
    it('should add a comment with plain text', async () => {
      mockClient.v3.issueComments.addComment.mockResolvedValue(mockComment);

      const comment = await operations.add('PROJ-123', 'Test comment');

      expect(mockClient.v3.issueComments.addComment).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        comment: {
          version: 1,
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Test comment' }],
            },
          ],
        },
        visibility: undefined,
      });
      expect(comment.id).toBe('10001');
    });

    it('should add a comment with ADF body', async () => {
      mockClient.v3.issueComments.addComment.mockResolvedValue(mockComment);

      const adfBody = {
        version: 1 as const,
        type: 'doc' as const,
        content: [
          {
            type: 'paragraph' as const,
            content: [{ type: 'text' as const, text: 'ADF comment' }],
          },
        ],
      };

      await operations.add('PROJ-123', adfBody);

      expect(mockClient.v3.issueComments.addComment).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        comment: adfBody,
        visibility: undefined,
      });
    });

    it('should add a comment with visibility restriction', async () => {
      mockClient.v3.issueComments.addComment.mockResolvedValue(mockComment);

      await operations.add('PROJ-123', {
        body: 'Private comment',
        visibility: { type: 'role', value: 'Administrators' },
      });

      expect(mockClient.v3.issueComments.addComment).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        comment: expect.any(Object),
        visibility: { type: 'role', value: 'Administrators' },
      });
    });
  });

  describe('list', () => {
    it('should list comments for an issue', async () => {
      mockClient.v3.issueComments.getComments.mockResolvedValue({
        comments: [mockComment],
      });

      const comments = await operations.list('PROJ-123');

      expect(mockClient.v3.issueComments.getComments).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        orderBy: '-created',
      });
      expect(comments).toHaveLength(1);
      expect(comments[0]?.id).toBe('10001');
    });

    it('should return empty array when no comments', async () => {
      mockClient.v3.issueComments.getComments.mockResolvedValue({
        comments: [],
      });

      const comments = await operations.list('PROJ-123');

      expect(comments).toHaveLength(0);
    });
  });

  describe('get', () => {
    it('should get a specific comment', async () => {
      mockClient.v3.issueComments.getComment.mockResolvedValue(mockComment);

      const comment = await operations.get('PROJ-123', '10001');

      expect(mockClient.v3.issueComments.getComment).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        id: '10001',
      });
      expect(comment.id).toBe('10001');
    });

    it('should throw JiraNotFoundError for non-existent comment', async () => {
      mockClient.v3.issueComments.getComment.mockRejectedValue({ status: 404 });

      await expect(operations.get('PROJ-123', '99999')).rejects.toThrow(JiraNotFoundError);
    });
  });

  describe('update', () => {
    it('should update a comment with plain text', async () => {
      mockClient.v3.issueComments.updateComment.mockResolvedValue({
        ...mockComment,
        body: {
          version: 1,
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Updated comment' }],
            },
          ],
        },
      });

      const comment = await operations.update('PROJ-123', '10001', 'Updated comment');

      expect(mockClient.v3.issueComments.updateComment).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        id: '10001',
        body: expect.any(Object),
      });
      expect(comment.id).toBe('10001');
    });
  });

  describe('delete', () => {
    it('should delete a comment', async () => {
      mockClient.v3.issueComments.deleteComment.mockResolvedValue(undefined);

      await operations.delete('PROJ-123', '10001');

      expect(mockClient.v3.issueComments.deleteComment).toHaveBeenCalledWith({
        issueIdOrKey: 'PROJ-123',
        id: '10001',
      });
    });
  });
});
