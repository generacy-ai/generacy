import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IssueOperations } from '../../../src/operations/issues.js';
import type { GitHubClient } from '../../../src/client.js';

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

describe('IssueOperations', () => {
  let mockClient: GitHubClient;
  let issueOps: IssueOperations;

  beforeEach(() => {
    mockClient = createMockClient();
    issueOps = new IssueOperations(mockClient);
  });

  describe('create', () => {
    it('should create an issue with valid params', async () => {
      const mockIssue = {
        number: 1,
        title: 'Test Issue',
        body: 'Test body',
        state: 'open',
        labels: [],
        assignees: [],
        milestone: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        closed_at: null,
        user: { id: 1, login: 'test-user', avatar_url: 'https://example.com/avatar', type: 'User' },
        url: 'https://api.github.com/repos/test-owner/test-repo/issues/1',
        html_url: 'https://github.com/test-owner/test-repo/issues/1',
      };

      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: mockIssue });

      const result = await issueOps.create({ title: 'Test Issue', body: 'Test body' });

      expect(result.number).toBe(1);
      expect(result.title).toBe('Test Issue');
      expect(result.body).toBe('Test body');
      expect(result.state).toBe('open');
      expect(mockClient.request).toHaveBeenCalledOnce();
    });

    it('should throw validation error for empty title', async () => {
      await expect(issueOps.create({ title: '' })).rejects.toThrow();
    });

    it('should throw validation error for title exceeding max length', async () => {
      const longTitle = 'a'.repeat(257);
      await expect(issueOps.create({ title: longTitle })).rejects.toThrow();
    });
  });

  describe('get', () => {
    it('should get an issue by number', async () => {
      const mockIssue = {
        number: 42,
        title: 'Test Issue',
        body: 'Test body',
        state: 'open',
        labels: [{ id: 1, name: 'bug', color: 'ff0000', description: null }],
        assignees: [{ id: 1, login: 'assignee', avatar_url: 'https://example.com/avatar', type: 'User' }],
        milestone: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
        closed_at: null,
        user: { id: 1, login: 'author', avatar_url: 'https://example.com/avatar', type: 'User' },
        url: 'https://api.github.com/repos/test-owner/test-repo/issues/42',
        html_url: 'https://github.com/test-owner/test-repo/issues/42',
      };

      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: mockIssue });

      const result = await issueOps.get(42);

      expect(result.number).toBe(42);
      expect(result.labels).toHaveLength(1);
      expect(result.labels[0]?.name).toBe('bug');
      expect(result.assignees).toHaveLength(1);
      expect(result.assignees[0]?.login).toBe('assignee');
    });
  });

  describe('update', () => {
    it('should update an issue', async () => {
      const mockIssue = {
        number: 1,
        title: 'Updated Title',
        body: 'Updated body',
        state: 'open',
        labels: [],
        assignees: [],
        milestone: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-03T00:00:00Z',
        closed_at: null,
        user: { id: 1, login: 'test-user', avatar_url: 'https://example.com/avatar', type: 'User' },
        url: 'https://api.github.com/repos/test-owner/test-repo/issues/1',
        html_url: 'https://github.com/test-owner/test-repo/issues/1',
      };

      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: mockIssue });

      const result = await issueOps.update(1, { title: 'Updated Title', body: 'Updated body' });

      expect(result.title).toBe('Updated Title');
      expect(result.body).toBe('Updated body');
    });
  });

  describe('close', () => {
    it('should close an issue', async () => {
      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: {} });

      await expect(issueOps.close(1)).resolves.toBeUndefined();
      expect(mockClient.request).toHaveBeenCalledOnce();
    });
  });

  describe('search', () => {
    it('should search issues', async () => {
      const mockSearchResults = {
        items: [
          {
            number: 1,
            title: 'Bug report',
            body: 'Description',
            state: 'open',
            labels: [],
            assignees: [],
            milestone: null,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            closed_at: null,
            user: { id: 1, login: 'user', avatar_url: 'https://example.com/avatar', type: 'User' },
            url: 'https://api.github.com/repos/test-owner/test-repo/issues/1',
            html_url: 'https://github.com/test-owner/test-repo/issues/1',
          },
        ],
      };

      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: mockSearchResults });

      const results = await issueOps.search('is:open label:bug');

      expect(results).toHaveLength(1);
      expect(results[0]?.title).toBe('Bug report');
    });

    it('should filter out pull requests from search results', async () => {
      const mockSearchResults = {
        items: [
          {
            number: 1,
            title: 'Issue',
            body: 'Issue body',
            state: 'open',
            labels: [],
            assignees: [],
            milestone: null,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            closed_at: null,
            user: { id: 1, login: 'user', avatar_url: '', type: 'User' },
            url: '',
            html_url: '',
          },
          {
            number: 2,
            title: 'PR',
            body: 'PR body',
            state: 'open',
            labels: [],
            assignees: [],
            milestone: null,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
            closed_at: null,
            user: { id: 1, login: 'user', avatar_url: '', type: 'User' },
            url: '',
            html_url: '',
            pull_request: {}, // This marks it as a PR
          },
        ],
      };

      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: mockSearchResults });

      const results = await issueOps.search('test');

      expect(results).toHaveLength(1);
      expect(results[0]?.number).toBe(1);
    });
  });

  describe('list', () => {
    it('should list issues with default filter', async () => {
      const mockIssues = [
        {
          number: 1,
          title: 'Issue 1',
          body: 'Body 1',
          state: 'open',
          labels: [],
          assignees: [],
          milestone: null,
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-01T00:00:00Z',
          closed_at: null,
          user: { id: 1, login: 'user', avatar_url: '', type: 'User' },
          url: '',
          html_url: '',
        },
      ];

      vi.mocked(mockClient.paginate).mockResolvedValueOnce(mockIssues);

      const results = await issueOps.list();

      expect(results).toHaveLength(1);
      expect(mockClient.paginate).toHaveBeenCalledOnce();
    });

    it('should list issues with filter', async () => {
      vi.mocked(mockClient.paginate).mockResolvedValueOnce([]);

      await issueOps.list({ state: 'closed', labels: ['bug'] });

      expect(mockClient.paginate).toHaveBeenCalledOnce();
    });
  });

  describe('exists', () => {
    it('should return true for existing issue', async () => {
      const mockIssue = {
        number: 1,
        title: 'Test',
        body: null,
        state: 'open',
        labels: [],
        assignees: [],
        milestone: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        closed_at: null,
        user: null,
        url: '',
        html_url: '',
      };

      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: mockIssue });

      const result = await issueOps.exists(1);

      expect(result).toBe(true);
    });
  });
});
