import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommentOperations } from '../../../src/operations/comments.js';
import type { GitHubClient } from '../../../src/client.js';
import { GitHubValidationError } from '../../../src/utils/errors.js';

// Mock the GitHubClient
function createMockClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    owner: 'test-owner',
    repo: 'test-repo',
    agentAccount: 'test-agent',
    triggerLabels: [],
    webhookSecret: undefined,
    rest: {} as GitHubClient['rest'],
    verifyAuth: vi.fn(),
    getRateLimit: vi.fn(),
    request: vi.fn(),
    paginate: vi.fn(),
    ...overrides,
  } as unknown as GitHubClient;
}

describe('CommentOperations', () => {
  let mockClient: GitHubClient;
  let commentOps: CommentOperations;

  beforeEach(() => {
    mockClient = createMockClient();
    commentOps = new CommentOperations(mockClient);
  });

  describe('add', () => {
    it('should add a comment to an issue', async () => {
      const mockComment = {
        id: 1,
        body: 'Test comment',
        user: { id: 1, login: 'test-user', avatar_url: 'https://example.com/avatar', type: 'User' },
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        html_url: 'https://github.com/test-owner/test-repo/issues/1#issuecomment-1',
      };

      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: mockComment });

      const result = await commentOps.add(1, 'Test comment');

      expect(result.id).toBe(1);
      expect(result.body).toBe('Test comment');
      expect(result.author.login).toBe('test-user');
      expect(mockClient.request).toHaveBeenCalledOnce();
    });

    it('should throw validation error for empty comment body', async () => {
      await expect(commentOps.add(1, '')).rejects.toThrow(GitHubValidationError);
    });

    it('should throw validation error for whitespace-only body', async () => {
      await expect(commentOps.add(1, '   ')).rejects.toThrow(GitHubValidationError);
    });
  });

  describe('update', () => {
    it('should update a comment', async () => {
      const mockComment = {
        id: 1,
        body: 'Updated comment',
        user: { id: 1, login: 'test-user', avatar_url: 'https://example.com/avatar', type: 'User' },
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        html_url: 'https://github.com/test-owner/test-repo/issues/1#issuecomment-1',
      };

      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: mockComment });

      const result = await commentOps.update(1, 'Updated comment');

      expect(result.body).toBe('Updated comment');
    });

    it('should throw validation error for empty update body', async () => {
      await expect(commentOps.update(1, '')).rejects.toThrow(GitHubValidationError);
    });
  });

  describe('delete', () => {
    it('should delete a comment', async () => {
      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: undefined });

      await expect(commentOps.delete(1)).resolves.toBeUndefined();
      expect(mockClient.request).toHaveBeenCalledOnce();
    });
  });

  describe('get', () => {
    it('should get a comment by ID', async () => {
      const mockComment = {
        id: 42,
        body: 'Test comment',
        user: { id: 1, login: 'test-user', avatar_url: 'https://example.com/avatar', type: 'User' },
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        html_url: 'https://github.com/test-owner/test-repo/issues/1#issuecomment-42',
      };

      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: mockComment });

      const result = await commentOps.get(42);

      expect(result.id).toBe(42);
      expect(result.body).toBe('Test comment');
    });
  });

  describe('list', () => {
    it('should list comments on an issue', async () => {
      const mockComments = [
        {
          id: 1,
          body: 'First comment',
          user: { id: 1, login: 'user1', avatar_url: '', type: 'User' },
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          html_url: '',
        },
        {
          id: 2,
          body: 'Second comment',
          user: { id: 2, login: 'user2', avatar_url: '', type: 'User' },
          created_at: '2024-01-02T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
          html_url: '',
        },
      ];

      vi.mocked(mockClient.paginate).mockResolvedValueOnce(mockComments);

      const results = await commentOps.list(1);

      expect(results).toHaveLength(2);
      expect(results[0]?.body).toBe('First comment');
      expect(results[1]?.body).toBe('Second comment');
    });
  });

  describe('listSince', () => {
    it('should list comments since a specific date', async () => {
      const mockComments = [
        {
          id: 2,
          body: 'Recent comment',
          user: { id: 1, login: 'user', avatar_url: '', type: 'User' },
          created_at: '2024-01-15T00:00:00Z',
          updated_at: '2024-01-15T00:00:00Z',
          html_url: '',
        },
      ];

      vi.mocked(mockClient.paginate).mockResolvedValueOnce(mockComments);

      const since = new Date('2024-01-10T00:00:00Z');
      const results = await commentOps.listSince(1, since);

      expect(results).toHaveLength(1);
      expect(results[0]?.body).toBe('Recent comment');
    });
  });

  describe('findByAuthor', () => {
    it('should find comments by author', async () => {
      const mockComments = [
        {
          id: 1,
          body: 'Comment by user1',
          user: { id: 1, login: 'user1', avatar_url: '', type: 'User' },
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          html_url: '',
        },
        {
          id: 2,
          body: 'Comment by user2',
          user: { id: 2, login: 'user2', avatar_url: '', type: 'User' },
          created_at: '2024-01-02T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
          html_url: '',
        },
        {
          id: 3,
          body: 'Another comment by user1',
          user: { id: 1, login: 'user1', avatar_url: '', type: 'User' },
          created_at: '2024-01-03T00:00:00Z',
          updated_at: '2024-01-03T00:00:00Z',
          html_url: '',
        },
      ];

      vi.mocked(mockClient.paginate).mockResolvedValueOnce(mockComments);

      const results = await commentOps.findByAuthor(1, 'user1');

      expect(results).toHaveLength(2);
      expect(results.every((c) => c.author.login === 'user1')).toBe(true);
    });
  });

  describe('findByPattern', () => {
    it('should find comments matching a pattern', async () => {
      const mockComments = [
        {
          id: 1,
          body: '@agent continue',
          user: { id: 1, login: 'user', avatar_url: '', type: 'User' },
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          html_url: '',
        },
        {
          id: 2,
          body: 'Regular comment',
          user: { id: 1, login: 'user', avatar_url: '', type: 'User' },
          created_at: '2024-01-02T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
          html_url: '',
        },
        {
          id: 3,
          body: 'Please @agent continue with the task',
          user: { id: 1, login: 'user', avatar_url: '', type: 'User' },
          created_at: '2024-01-03T00:00:00Z',
          updated_at: '2024-01-03T00:00:00Z',
          html_url: '',
        },
      ];

      vi.mocked(mockClient.paginate).mockResolvedValueOnce(mockComments);

      const results = await commentOps.findByPattern(1, /@agent\s+continue/i);

      expect(results).toHaveLength(2);
      expect(results[0]?.id).toBe(1);
      expect(results[1]?.id).toBe(3);
    });
  });
});
