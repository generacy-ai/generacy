import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCheckRun,
  updateCheckRun,
  getCheckRun,
  listCheckRuns,
  listCheckRunsForSuite,
} from '../../src/operations/check-runs.js';
import { GitHubClient } from '../../src/client.js';
import { CheckRunNotFoundError } from '../../src/utils/errors.js';

vi.mock('../../src/client.js', () => ({
  GitHubClient: vi.fn(),
}));

describe('check-runs operations', () => {
  let mockClient: GitHubClient;

  const mockCheckRun = {
    id: 2001,
    node_id: 'MDEwOkNoZWNrU3VpdGUx',
    name: 'test-check',
    head_sha: 'abc123def456789012345678901234567890abcd',
    external_id: 'ext-123',
    status: 'completed',
    conclusion: 'success',
    details_url: 'https://example.com/check-details',
    html_url: 'https://github.com/owner/repo/runs/2001',
    output: {
      title: 'Test Results',
      summary: 'All tests passed',
      text: null,
      annotations_count: 0,
    },
    started_at: '2024-01-01T00:00:00Z',
    completed_at: '2024-01-01T00:01:00Z',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      getOwner: vi.fn().mockReturnValue('test-owner'),
      getRepo: vi.fn().mockReturnValue('test-repo'),
      request: vi.fn(),
      requestRaw: vi.fn(),
    } as unknown as GitHubClient;
  });

  describe('createCheckRun', () => {
    it('should create a new check run', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockCheckRun
      );

      const result = await createCheckRun(mockClient, {
        name: 'test-check',
        head_sha: 'abc123def456789012345678901234567890abcd',
        status: 'in_progress',
      });

      expect(result.id).toBe(2001);
      expect(result.name).toBe('test-check');
    });

    it('should create check run with output', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockCheckRun
      );

      await createCheckRun(mockClient, {
        name: 'test-check',
        head_sha: 'abc123def456789012345678901234567890abcd',
        output: {
          title: 'Test Results',
          summary: 'Running tests...',
        },
      });

      expect(mockClient.request).toHaveBeenCalled();
    });

    it('should create check run with annotations', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockCheckRun
      );

      await createCheckRun(mockClient, {
        name: 'test-check',
        head_sha: 'abc123def456789012345678901234567890abcd',
        output: {
          title: 'Lint Results',
          summary: '2 issues found',
          annotations: [
            {
              path: 'src/index.ts',
              start_line: 10,
              end_line: 10,
              annotation_level: 'warning',
              message: 'Unused variable',
            },
          ],
        },
      });

      expect(mockClient.request).toHaveBeenCalled();
    });
  });

  describe('updateCheckRun', () => {
    it('should update an existing check run', async () => {
      const updatedCheck = { ...mockCheckRun, status: 'completed' };
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        updatedCheck
      );

      const result = await updateCheckRun(mockClient, 2001, {
        status: 'completed',
        conclusion: 'success',
      });

      expect(result.status).toBe('completed');
    });

    it('should throw CheckRunNotFoundError on Not Found', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Not Found')
      );

      await expect(
        updateCheckRun(mockClient, 9999, { status: 'completed' })
      ).rejects.toThrow(CheckRunNotFoundError);
    });
  });

  describe('getCheckRun', () => {
    it('should return a check run by ID', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockCheckRun
      );

      const result = await getCheckRun(mockClient, 2001);

      expect(result.id).toBe(2001);
      expect(result.head_sha).toBe('abc123def456789012345678901234567890abcd');
    });

    it('should throw CheckRunNotFoundError on Not Found', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Not Found')
      );

      await expect(getCheckRun(mockClient, 9999)).rejects.toThrow(
        CheckRunNotFoundError
      );
    });
  });

  describe('listCheckRuns', () => {
    it('should list check runs for a ref', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        check_runs: [mockCheckRun],
      });

      const results = await listCheckRuns(mockClient, 'main');

      expect(results).toHaveLength(1);
      expect(results[0]?.name).toBe('test-check');
    });

    it('should accept filter options', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        check_runs: [],
      });

      await listCheckRuns(mockClient, 'abc123', {
        check_name: 'lint',
        status: 'completed',
        filter: 'latest',
      });

      expect(mockClient.request).toHaveBeenCalled();
    });
  });

  describe('listCheckRunsForSuite', () => {
    it('should list check runs for a check suite', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        check_runs: [mockCheckRun],
      });

      const results = await listCheckRunsForSuite(mockClient, 3001);

      expect(results).toHaveLength(1);
    });
  });
});
