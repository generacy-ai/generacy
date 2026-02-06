import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  StatusPoller,
  createStatusPoller,
  pollUntilComplete,
  waitForRun,
} from '../../src/polling/status-poller.js';
import { GitHubClient } from '../../src/client.js';
import { PollingTimeoutError, RateLimitError } from '../../src/utils/errors.js';
import * as runsModule from '../../src/operations/runs.js';

vi.mock('../../src/client.js', () => ({
  GitHubClient: vi.fn(),
}));

vi.mock('../../src/operations/runs.js', () => ({
  getWorkflowRun: vi.fn(),
}));

describe('StatusPoller', () => {
  let mockClient: GitHubClient;

  const createMockRun = (
    status: 'queued' | 'in_progress' | 'completed',
    conclusion: string | null = null
  ) => ({
    id: 123,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    head_branch: 'main',
    head_sha: 'abc123',
    status,
    conclusion,
    html_url: 'https://github.com/owner/repo/actions/runs/123',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    run_started_at: null,
    actor: { id: 1, login: 'user', avatar_url: '', type: 'User' as const },
    event: 'push',
    run_attempt: 1,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockClient = {
      getOwner: vi.fn().mockReturnValue('test-owner'),
      getRepo: vi.fn().mockReturnValue('test-repo'),
      request: vi.fn(),
      requestRaw: vi.fn(),
    } as unknown as GitHubClient;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('poll', () => {
    it('should return immediately if run is already completed', async () => {
      const completedRun = createMockRun('completed', 'success');
      vi.mocked(runsModule.getWorkflowRun).mockResolvedValueOnce(completedRun);

      const poller = new StatusPoller(mockClient, { interval: 1000, maxAttempts: 10 });
      const resultPromise = poller.poll(123);

      // Advance timers to let the poll complete
      await vi.advanceTimersByTimeAsync(0);

      const result = await resultPromise;

      expect(result.completed).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.run.conclusion).toBe('success');
    });

    it('should poll until run completes', async () => {
      const queuedRun = createMockRun('queued');
      const inProgressRun = createMockRun('in_progress');
      const completedRun = createMockRun('completed', 'success');

      vi.mocked(runsModule.getWorkflowRun)
        .mockResolvedValueOnce(queuedRun)
        .mockResolvedValueOnce(inProgressRun)
        .mockResolvedValueOnce(completedRun);

      const onUpdate = vi.fn();
      const onComplete = vi.fn();

      const poller = new StatusPoller(mockClient, {
        interval: 1000,
        maxAttempts: 10,
        onUpdate,
        onComplete,
      });

      const resultPromise = poller.poll(123);

      // First poll
      await vi.advanceTimersByTimeAsync(0);
      // Wait for interval and second poll
      await vi.advanceTimersByTimeAsync(1000);
      // Wait for interval and third poll
      await vi.advanceTimersByTimeAsync(1000);

      const result = await resultPromise;

      expect(result.completed).toBe(true);
      expect(result.attempts).toBe(3);
      expect(onUpdate).toHaveBeenCalledTimes(3); // queued, in_progress, completed
      expect(onComplete).toHaveBeenCalledWith(completedRun);
    });

    it('should throw PollingTimeoutError when max attempts exceeded', async () => {
      const inProgressRun = createMockRun('in_progress');
      vi.mocked(runsModule.getWorkflowRun).mockResolvedValue(inProgressRun);

      const poller = new StatusPoller(mockClient, {
        interval: 100,
        maxAttempts: 3,
      });

      // Set up a promise that catches the expected error
      let caughtError: Error | null = null;
      const resultPromise = poller.poll(123).catch((error) => {
        caughtError = error;
      });

      // Advance through all attempts - need to advance enough for all polls and waits
      await vi.advanceTimersByTimeAsync(0);   // attempt 1
      await vi.advanceTimersByTimeAsync(100); // wait + attempt 2
      await vi.advanceTimersByTimeAsync(100); // wait + attempt 3

      // Wait for the promise to complete
      await resultPromise;

      expect(caughtError).toBeInstanceOf(PollingTimeoutError);
    });

    it('should use exponential backoff on rate limit', async () => {
      const resetAt = new Date(Date.now() + 5000);
      const rateLimitError = new RateLimitError(resetAt);
      const completedRun = createMockRun('completed', 'success');

      vi.mocked(runsModule.getWorkflowRun)
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(completedRun);

      const onError = vi.fn();
      const poller = new StatusPoller(mockClient, {
        interval: 1000,
        maxAttempts: 10,
        onError,
      });

      const resultPromise = poller.poll(123);

      // First poll (rate limited)
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).toHaveBeenCalledWith(rateLimitError);

      // Wait for backoff and second poll
      await vi.advanceTimersByTimeAsync(6000);

      const result = await resultPromise;
      expect(result.completed).toBe(true);
    });
  });

  describe('start', () => {
    it('should return a handle with cancel function', async () => {
      const inProgressRun = createMockRun('in_progress');
      vi.mocked(runsModule.getWorkflowRun).mockResolvedValue(inProgressRun);

      const poller = new StatusPoller(mockClient, {
        interval: 1000,
        maxAttempts: 100,
      });

      const handle = poller.start(123);

      expect(handle.isActive()).toBe(true);

      // Cancel after first poll
      await vi.advanceTimersByTimeAsync(0);
      handle.cancel();

      expect(handle.isActive()).toBe(false);
    });
  });

  describe('createStatusPoller', () => {
    it('should create a StatusPoller instance', () => {
      const poller = createStatusPoller(mockClient);
      expect(poller).toBeInstanceOf(StatusPoller);
    });
  });

  describe('pollUntilComplete', () => {
    it('should poll and return completed run', async () => {
      const completedRun = createMockRun('completed', 'success');
      vi.mocked(runsModule.getWorkflowRun).mockResolvedValueOnce(completedRun);

      const resultPromise = pollUntilComplete(mockClient, 123);
      await vi.advanceTimersByTimeAsync(0);

      const result = await resultPromise;
      expect(result.conclusion).toBe('success');
    });
  });

  describe('waitForRun', () => {
    it('should return timedOut: true when timeout reached', async () => {
      const inProgressRun = createMockRun('in_progress');
      vi.mocked(runsModule.getWorkflowRun).mockResolvedValue(inProgressRun);

      const resultPromise = waitForRun(mockClient, 123, 2000, 1000);

      // 2 attempts max (2000ms / 1000ms)
      await vi.advanceTimersByTimeAsync(0);    // attempt 1
      await vi.advanceTimersByTimeAsync(1000); // attempt 2

      const result = await resultPromise;
      expect(result.timedOut).toBe(true);
      expect(result.completed).toBe(false);
    });
  });
});
