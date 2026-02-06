import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getJobs,
  getJob,
  getJobLogs,
  getFailedJobs,
} from '../../src/operations/jobs.js';
import { GitHubClient } from '../../src/client.js';
import { JobNotFoundError, RunNotFoundError } from '../../src/utils/errors.js';

vi.mock('../../src/client.js', () => ({
  GitHubClient: vi.fn(),
}));

describe('jobs operations', () => {
  let mockClient: GitHubClient;

  const mockJob = {
    id: 456,
    run_id: 123,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    steps: [
      {
        name: 'Checkout',
        status: 'completed',
        conclusion: 'success',
        number: 1,
        started_at: '2024-01-01T00:00:00Z',
        completed_at: '2024-01-01T00:00:10Z',
      },
      {
        name: 'Build',
        status: 'completed',
        conclusion: 'success',
        number: 2,
        started_at: '2024-01-01T00:00:10Z',
        completed_at: '2024-01-01T00:01:00Z',
      },
    ],
    started_at: '2024-01-01T00:00:00Z',
    completed_at: '2024-01-01T00:01:00Z',
    runner_id: 1,
    runner_name: 'ubuntu-latest',
  };

  const mockFailedJob = {
    ...mockJob,
    id: 789,
    name: 'test',
    conclusion: 'failure',
    steps: [
      {
        name: 'Run tests',
        status: 'completed',
        conclusion: 'failure',
        number: 1,
        started_at: '2024-01-01T00:00:00Z',
        completed_at: '2024-01-01T00:00:30Z',
      },
    ],
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

  describe('getJobs', () => {
    it('should return jobs for a workflow run', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        jobs: [mockJob],
      });

      const jobs = await getJobs(mockClient, 123);

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.name).toBe('build');
      expect(jobs[0]?.steps).toHaveLength(2);
    });

    it('should throw RunNotFoundError on Not Found', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Not Found')
      );

      await expect(getJobs(mockClient, 999)).rejects.toThrow(RunNotFoundError);
    });
  });

  describe('getJob', () => {
    it('should return a specific job', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockJob
      );

      const job = await getJob(mockClient, 456);

      expect(job.id).toBe(456);
      expect(job.name).toBe('build');
    });

    it('should throw JobNotFoundError on Not Found', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Not Found')
      );

      await expect(getJob(mockClient, 999)).rejects.toThrow(JobNotFoundError);
    });
  });

  describe('getJobLogs', () => {
    it('should return job logs as string', async () => {
      const mockLogs = '2024-01-01T00:00:00Z Running tests...\n2024-01-01T00:00:30Z Tests passed!';
      (mockClient.requestRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: mockLogs,
      });

      const logs = await getJobLogs(mockClient, 456);

      expect(logs).toBe(mockLogs);
    });

    it('should handle ArrayBuffer response', async () => {
      const mockLogs = 'Log content';
      const encoder = new TextEncoder();
      const buffer = encoder.encode(mockLogs).buffer;
      (mockClient.requestRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        data: buffer,
      });

      const logs = await getJobLogs(mockClient, 456);

      expect(logs).toBe(mockLogs);
    });

    it('should throw JobNotFoundError on Not Found', async () => {
      (mockClient.requestRaw as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('Not Found')
      );

      await expect(getJobLogs(mockClient, 999)).rejects.toThrow(JobNotFoundError);
    });
  });

  describe('getFailedJobs', () => {
    it('should return only failed jobs', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        jobs: [mockJob, mockFailedJob],
      });

      const failedJobs = await getFailedJobs(mockClient, 123);

      expect(failedJobs).toHaveLength(1);
      expect(failedJobs[0]?.name).toBe('test');
      expect(failedJobs[0]?.conclusion).toBe('failure');
    });

    it('should return empty array if no failed jobs', async () => {
      (mockClient.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        jobs: [mockJob],
      });

      const failedJobs = await getFailedJobs(mockClient, 123);

      expect(failedJobs).toHaveLength(0);
    });
  });
});
