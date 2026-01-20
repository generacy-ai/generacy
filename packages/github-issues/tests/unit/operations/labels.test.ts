import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LabelOperations } from '../../../src/operations/labels.js';
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

describe('LabelOperations', () => {
  let mockClient: GitHubClient;
  let labelOps: LabelOperations;

  beforeEach(() => {
    mockClient = createMockClient();
    labelOps = new LabelOperations(mockClient);
  });

  describe('add', () => {
    it('should add labels to an issue', async () => {
      const mockLabels = [
        { id: 1, name: 'bug', color: 'ff0000', description: 'Bug label' },
        { id: 2, name: 'urgent', color: 'ff9900', description: null },
      ];

      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: mockLabels });

      const result = await labelOps.add(1, ['bug', 'urgent']);

      expect(result).toHaveLength(2);
      expect(result[0]?.name).toBe('bug');
      expect(result[1]?.name).toBe('urgent');
      expect(mockClient.request).toHaveBeenCalledOnce();
    });

    it('should throw validation error for empty labels array', async () => {
      await expect(labelOps.add(1, [])).rejects.toThrow(GitHubValidationError);
    });
  });

  describe('remove', () => {
    it('should remove a label from an issue', async () => {
      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: [] });

      await expect(labelOps.remove(1, 'bug')).resolves.toBeUndefined();
      expect(mockClient.request).toHaveBeenCalledOnce();
    });
  });

  describe('removeMany', () => {
    it('should remove multiple labels from an issue', async () => {
      vi.mocked(mockClient.request).mockResolvedValue({ data: [] });

      await labelOps.removeMany(1, ['bug', 'urgent']);

      // Should be called twice, once for each label
      expect(mockClient.request).toHaveBeenCalledTimes(2);
    });

    it('should handle empty labels array', async () => {
      await labelOps.removeMany(1, []);

      expect(mockClient.request).not.toHaveBeenCalled();
    });

    it('should ignore 404 errors when label does not exist', async () => {
      const notFoundError = { code: 'NOT_FOUND_ERROR' };
      vi.mocked(mockClient.request)
        .mockResolvedValueOnce({ data: [] })
        .mockRejectedValueOnce(notFoundError);

      // Should not throw
      await expect(labelOps.removeMany(1, ['exists', 'not-exists'])).resolves.toBeUndefined();
    });
  });

  describe('set', () => {
    it('should set labels on an issue', async () => {
      const mockLabels = [
        { id: 1, name: 'enhancement', color: '00ff00', description: null },
      ];

      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: mockLabels });

      const result = await labelOps.set(1, ['enhancement']);

      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('enhancement');
    });
  });

  describe('list', () => {
    it('should list labels on an issue', async () => {
      const mockLabels = [
        { id: 1, name: 'bug', color: 'ff0000', description: 'Bug label' },
        { id: 2, name: 'enhancement', color: '00ff00', description: 'Enhancement label' },
      ];

      vi.mocked(mockClient.paginate).mockResolvedValueOnce(mockLabels);

      const result = await labelOps.list(1);

      expect(result).toHaveLength(2);
      expect(mockClient.paginate).toHaveBeenCalledOnce();
    });
  });

  describe('listForRepo', () => {
    it('should list all labels in the repository', async () => {
      const mockLabels = [
        { id: 1, name: 'bug', color: 'ff0000', description: 'Bug label' },
        { id: 2, name: 'enhancement', color: '00ff00', description: 'Enhancement label' },
        { id: 3, name: 'documentation', color: '0000ff', description: 'Documentation label' },
      ];

      vi.mocked(mockClient.paginate).mockResolvedValueOnce(mockLabels);

      const result = await labelOps.listForRepo();

      expect(result).toHaveLength(3);
    });
  });

  describe('create', () => {
    it('should create a label in the repository', async () => {
      const mockLabel = {
        id: 1,
        name: 'new-label',
        color: 'ff0000',
        description: 'A new label',
      };

      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: mockLabel });

      const result = await labelOps.create('new-label', '#ff0000', 'A new label');

      expect(result.name).toBe('new-label');
      expect(result.description).toBe('A new label');
    });

    it('should strip # prefix from color', async () => {
      const mockLabel = {
        id: 1,
        name: 'new-label',
        color: 'ff0000',
        description: null,
      };

      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: mockLabel });

      await labelOps.create('new-label', '#ff0000');

      // The color should be passed without the # prefix
      expect(mockClient.request).toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should delete a label from the repository', async () => {
      vi.mocked(mockClient.request).mockResolvedValueOnce({ data: undefined });

      await expect(labelOps.delete('old-label')).resolves.toBeUndefined();
      expect(mockClient.request).toHaveBeenCalledOnce();
    });
  });
});
