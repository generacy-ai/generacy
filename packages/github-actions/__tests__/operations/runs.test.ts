import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getWorkflowRun,
  listWorkflowRuns,
  cancelWorkflowRun,
  rerunWorkflowRun,
  rerunFailedJobs,
} from '../../src/operations/runs.js';
import { GitHubClient } from '../../src/client.js';
import { RunNotFoundError } from '../../src/utils/errors.js';

vi.mock('../../src/client.js', () => ({
  GitHubClient: vi.fn(),
}));

describe('runs operations', () => {
  let mockClient: GitHubClient;

  const mockWorkflowRun = {
    id: 123,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    head_branch: 'main',
    head_sha: 'abc123def456',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/owner/repo/actions/runs/123',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:01:00Z',
    run_started_at: '2024-01-01T00:00:00Z',
    actor: {
      id: 1,
      login: 'test-user',
      avatar_url: 'https://avatars.githubusercontent.com/u/1',
      type: 'User',
    },
    event: 'push',
    run_attempt: 1,
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

  describe('getWorkflowRun', () => {
    it('should return a workflow run by ID', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockWorkflowRun
      );

      const result = await getWorkflowRun(mockClient, 123);

      expect(result.id).toBe(123);
      expect(result.status).toBe('completed');
      expect(result.conclusion).toBe('success');
    });

    it('should throw RunNotFoundError on Not Found', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Not Found')
      );

      await expect(getWorkflowRun(mockClient, 999)).rejects.toThrow(
        RunNotFoundError
      );
    });
  });

  describe('listWorkflowRuns', () => {
    it('should list workflow runs', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        workflow_runs: [mockWorkflowRun],
      });

      const results = await listWorkflowRuns(mockClient, 'ci.yml');

      expect(results).toHaveLength(1);
      expect(results[0]?.id).toBe(123);
    });

    it('should accept filter options', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        workflow_runs: [],
      });

      await listWorkflowRuns(mockClient, 'ci.yml', {
        branch: 'develop',
        status: 'completed',
        per_page: 10,
      });

      expect(mockClient.request).toHaveBeenCalled();
    });
  });

  describe('cancelWorkflowRun', () => {
    it('should cancel a workflow run', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({});

      await expect(cancelWorkflowRun(mockClient, 123)).resolves.not.toThrow();
    });

    it('should throw RunNotFoundError on Not Found', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Not Found')
      );

      await expect(cancelWorkflowRun(mockClient, 999)).rejects.toThrow(
        RunNotFoundError
      );
    });
  });

  describe('rerunWorkflowRun', () => {
    it('should rerun a workflow and return the updated run', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // reRunWorkflow
        .mockResolvedValueOnce({ ...mockWorkflowRun, run_attempt: 2 }); // getWorkflowRun

      const result = await rerunWorkflowRun(mockClient, 123);

      expect(result.run_attempt).toBe(2);
    });

    it('should throw RunNotFoundError on Not Found', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Not Found')
      );

      await expect(rerunWorkflowRun(mockClient, 999)).rejects.toThrow(
        RunNotFoundError
      );
    });
  });

  describe('rerunFailedJobs', () => {
    it('should rerun failed jobs and return the updated run', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({}) // reRunWorkflowFailedJobs
        .mockResolvedValueOnce({ ...mockWorkflowRun, status: 'in_progress' }); // getWorkflowRun

      const result = await rerunFailedJobs(mockClient, 123);

      expect(result.status).toBe('in_progress');
    });
  });
});
