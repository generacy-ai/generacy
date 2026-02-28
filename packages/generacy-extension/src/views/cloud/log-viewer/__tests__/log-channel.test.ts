/**
 * Unit tests for JobLogChannel
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Disposable } from 'vscode';
import type { SSEEvent, JobLogLine, JobLogsResponse } from '../../../../api/types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockOutputChannel = {
  appendLine: vi.fn(),
  clear: vi.fn(),
  show: vi.fn(),
  dispose: vi.fn(),
};

vi.mock('vscode', () => ({
  window: {
    createOutputChannel: vi.fn(() => mockOutputChannel),
  },
  Disposable: class {
    static from = vi.fn();
    constructor(private callOnDispose: () => void) {}
    dispose() {
      this.callOnDispose();
    }
  },
}));

const mockLogger = {
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
};

vi.mock('../../../../utils/logger', () => ({
  getLogger: vi.fn(() => mockLogger),
}));

const mockGetJobLogs = vi.fn<(id: string, options?: { limit?: number }) => Promise<JobLogsResponse>>();

vi.mock('../../../../api/endpoints/queue', () => ({
  queueApi: {
    getJobLogs: (...args: unknown[]) => mockGetJobLogs(...(args as [string, { limit?: number }?])),
  },
}));

/** Captured SSE handler from the most recent subscribe() call */
let capturedSSEHandler: ((event: SSEEvent) => void) | undefined;
/** Captured connection state handler from onDidChangeConnectionState */
let capturedConnectionStateHandler: ((state: string) => void) | undefined;
const mockSSEDisposable = { dispose: vi.fn() };
const mockConnectionStateDisposable = { dispose: vi.fn() };
const mockSSESubscribe = vi.fn((
  _channel: string,
  handler: (event: SSEEvent) => void,
): Disposable => {
  capturedSSEHandler = handler;
  return mockSSEDisposable;
});
const mockOnDidChangeConnectionState = vi.fn((
  handler: (state: string) => void,
): Disposable => {
  capturedConnectionStateHandler = handler;
  return mockConnectionStateDisposable;
});

vi.mock('../../../../api/sse', () => ({
  SSESubscriptionManager: {
    getInstance: vi.fn(() => ({
      subscribe: mockSSESubscribe,
      onDidChangeConnectionState: mockOnDidChangeConnectionState,
    })),
  },
}));

// Import after mocks are set up
import { JobLogChannel } from '../log-channel';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JOB_ID = 'job-1234-abcd-5678';
const WORKFLOW_NAME = 'deploy-service';

function createLogLine(overrides: Partial<JobLogLine> = {}): JobLogLine {
  return {
    content: 'hello world',
    stream: 'stdout',
    timestamp: '2026-02-23T12:00:00.000Z',
    ...overrides,
  };
}

function createLogsResponse(overrides: Partial<JobLogsResponse> = {}): JobLogsResponse {
  return {
    lines: [createLogLine()],
    total: 1,
    cursor: 'cursor-abc',
    truncated: false,
    ...overrides,
  };
}

function createSSEEvent(overrides: Partial<SSEEvent> = {}): SSEEvent {
  return {
    id: 'evt-1',
    event: 'job:log',
    channel: 'jobs',
    data: { jobId: JOB_ID, content: 'live line', stream: 'stdout', timestamp: '2026-02-23T12:01:00.000Z' },
    timestamp: '2026-02-23T12:01:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('JobLogChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    capturedSSEHandler = undefined;
    capturedConnectionStateHandler = undefined;
    // Reset the static activeChannels map between tests
    JobLogChannel.disposeAll();
  });

  afterEach(() => {
    JobLogChannel.disposeAll();
    vi.useRealTimers();
  });

  // =========================================================================
  // openJobLogs (static factory)
  // =========================================================================

  describe('openJobLogs', () => {
    it('should create a new channel and call open()', async () => {
      mockGetJobLogs.mockResolvedValueOnce(createLogsResponse());

      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      // Output channel was created with a descriptive name
      const vscode = await import('vscode');
      expect(vscode.window.createOutputChannel).toHaveBeenCalledWith(
        `Job: ${WORKFLOW_NAME} (${JOB_ID.slice(0, 8)})`
      );

      // Historical logs were fetched
      expect(mockGetJobLogs).toHaveBeenCalledWith(JOB_ID, { limit: 10_000 });

      // SSE subscription was registered on the 'jobs' channel
      expect(mockSSESubscribe).toHaveBeenCalledWith('jobs', expect.any(Function));

      // Output channel was shown
      expect(mockOutputChannel.show).toHaveBeenCalledWith(true);
    });

    it('should reuse existing channel for the same jobId', async () => {
      mockGetJobLogs.mockResolvedValue(createLogsResponse());

      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);
      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      // createOutputChannel should only be called once (reuse)
      const vscode = await import('vscode');
      expect(vscode.window.createOutputChannel).toHaveBeenCalledTimes(1);

      // But open() is called twice (historical fetch + SSE subscription each time)
      expect(mockGetJobLogs).toHaveBeenCalledTimes(2);
    });

    it('should create separate channels for different jobIds', async () => {
      mockGetJobLogs.mockResolvedValue(createLogsResponse());

      await JobLogChannel.openJobLogs('job-aaa', WORKFLOW_NAME);
      await JobLogChannel.openJobLogs('job-bbb', WORKFLOW_NAME);

      const vscode = await import('vscode');
      expect(vscode.window.createOutputChannel).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // open() — historical log display
  // =========================================================================

  describe('open — historical logs', () => {
    it('should display header, historical lines, and live-stream banner', async () => {
      const lines = [
        createLogLine({ content: 'line 1', timestamp: '2026-02-23T12:00:00.000Z' }),
        createLogLine({ content: 'line 2', timestamp: '2026-02-23T12:00:01.000Z' }),
      ];
      mockGetJobLogs.mockResolvedValueOnce(createLogsResponse({ lines, total: 2 }));

      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);

      // Header
      expect(calls[0]).toContain(`Logs for ${WORKFLOW_NAME}`);
      expect(calls[0]).toContain(JOB_ID.slice(0, 8));

      // Historical lines are formatted with timestamps
      const logLines = calls.filter((c: string) => c.includes('line 1') || c.includes('line 2'));
      expect(logLines).toHaveLength(2);

      // Summary
      const summary = calls.find((c: string) => c.includes('2 of 2 historical lines'));
      expect(summary).toBeDefined();

      // Live stream banner
      const liveBanner = calls.find((c: string) => c.includes('Live log stream active'));
      expect(liveBanner).toBeDefined();
    });

    it('should show "Waiting for job to start..." when no historical lines exist', async () => {
      mockGetJobLogs.mockResolvedValueOnce(createLogsResponse({ lines: [], total: 0 }));

      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls).toContainEqual('Waiting for job to start...');
    });

    it('should show truncation notice when response is truncated', async () => {
      const lines = Array.from({ length: 5 }, (_, i) =>
        createLogLine({ content: `line ${i}` })
      );
      mockGetJobLogs.mockResolvedValueOnce(
        createLogsResponse({ lines, total: 50_000, truncated: true })
      );

      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      const truncationNotice = calls.find(
        (c: string) => c.includes('Showing last 5 of 50000 lines')
      );
      expect(truncationNotice).toBeDefined();
    });
  });

  // =========================================================================
  // formatLogLine
  // =========================================================================

  describe('log line formatting', () => {
    it('should format stdout lines with timestamp only', async () => {
      const line = createLogLine({
        content: 'stdout output',
        stream: 'stdout',
        timestamp: '2026-02-23T12:00:00.000Z',
      });
      mockGetJobLogs.mockResolvedValueOnce(createLogsResponse({ lines: [line], total: 1 }));

      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      const formatted = calls.find((c: string) => c.includes('stdout output'));
      expect(formatted).toBeDefined();
      expect(formatted).not.toContain('[ERR]');
    });

    it('should format stderr lines with [ERR] prefix', async () => {
      const line = createLogLine({
        content: 'error output',
        stream: 'stderr',
        timestamp: '2026-02-23T12:00:00.000Z',
      });
      mockGetJobLogs.mockResolvedValueOnce(createLogsResponse({ lines: [line], total: 1 }));

      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      const formatted = calls.find((c: string) => c.includes('error output'));
      expect(formatted).toBeDefined();
      expect(formatted).toContain('[ERR]');
    });
  });

  // =========================================================================
  // SSE event handling
  // =========================================================================

  describe('SSE event handling', () => {
    beforeEach(async () => {
      mockGetJobLogs.mockResolvedValueOnce(createLogsResponse());
      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);
      mockOutputChannel.appendLine.mockClear();
    });

    it('should append formatted log line on job:log event', () => {
      expect(capturedSSEHandler).toBeDefined();

      capturedSSEHandler!(createSSEEvent({
        event: 'job:log',
        data: {
          jobId: JOB_ID,
          content: 'live log message',
          stream: 'stdout',
          timestamp: '2026-02-23T12:01:00.000Z',
        },
      }));

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      const logCall = calls.find((c: string) => c.includes('live log message'));
      expect(logCall).toBeDefined();
      expect(logCall).not.toContain('[ERR]');
    });

    it('should format stderr SSE log events with [ERR] prefix', () => {
      capturedSSEHandler!(createSSEEvent({
        event: 'job:log',
        data: {
          jobId: JOB_ID,
          content: 'stderr message',
          stream: 'stderr',
          timestamp: '2026-02-23T12:01:00.000Z',
        },
      }));

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      const logCall = calls.find((c: string) => c.includes('stderr message'));
      expect(logCall).toContain('[ERR]');
    });

    it('should ignore events for other jobIds', () => {
      capturedSSEHandler!(createSSEEvent({
        event: 'job:log',
        data: {
          jobId: 'other-job-id',
          content: 'should be ignored',
          stream: 'stdout',
          timestamp: '2026-02-23T12:01:00.000Z',
        },
      }));

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls.some((c: string) => c.includes('should be ignored'))).toBe(false);
    });

    it('should ignore events with no data', () => {
      capturedSSEHandler!(createSSEEvent({
        event: 'job:log',
        data: undefined,
      }));

      expect(mockOutputChannel.appendLine).not.toHaveBeenCalled();
    });

    it('should insert step separator on job:step-start event', () => {
      capturedSSEHandler!(createSSEEvent({
        event: 'job:step-start',
        data: {
          jobId: JOB_ID,
          stepName: 'implementation',
        },
      }));

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      const separator = calls.find((c: string) => c.includes('Step: implementation'));
      expect(separator).toBeDefined();
      // Separator uses ─ characters
      expect(separator).toMatch(/─/);
    });

    it('should use "unknown" for step-start events without stepName', () => {
      capturedSSEHandler!(createSSEEvent({
        event: 'job:step-start',
        data: {
          jobId: JOB_ID,
        },
      }));

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      const separator = calls.find((c: string) => c.includes('Step: unknown'));
      expect(separator).toBeDefined();
    });

    it('should show terminal status and stop SSE on job:log:end event', () => {
      capturedSSEHandler!(createSSEEvent({
        event: 'job:log:end',
        data: {
          jobId: JOB_ID,
          status: 'completed',
        },
      }));

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls).toContainEqual('--- Job completed ---');

      // SSE subscription should be disposed
      expect(mockSSEDisposable.dispose).toHaveBeenCalled();
    });

    it('should use "ended" as default status when not provided', () => {
      capturedSSEHandler!(createSSEEvent({
        event: 'job:log:end',
        data: {
          jobId: JOB_ID,
        },
      }));

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls).toContainEqual('--- Job ended ---');
    });

    it('should handle log events with non-string content gracefully', () => {
      capturedSSEHandler!(createSSEEvent({
        event: 'job:log',
        data: {
          jobId: JOB_ID,
          content: 42,
          stream: 'stdout',
          timestamp: '2026-02-23T12:01:00.000Z',
        },
      }));

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      const logCall = calls.find((c: string) => c.includes('42'));
      expect(logCall).toBeDefined();
    });
  });

  // =========================================================================
  // Connection status indicator
  // =========================================================================

  describe('connection status indicator', () => {
    beforeEach(async () => {
      mockGetJobLogs.mockResolvedValueOnce(createLogsResponse());
      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);
      mockOutputChannel.appendLine.mockClear();
    });

    it('should subscribe to connection state changes', () => {
      expect(mockOnDidChangeConnectionState).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should display reconnecting status on "connecting" state', () => {
      expect(capturedConnectionStateHandler).toBeDefined();
      capturedConnectionStateHandler!('connecting');

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls).toContainEqual('[SSE] Reconnecting...');
    });

    it('should display connected status on "connected" state', () => {
      capturedConnectionStateHandler!('connected');

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls).toContainEqual('[SSE] Connected');
    });

    it('should display error status on "error" state', () => {
      capturedConnectionStateHandler!('error');

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls).toContainEqual('[SSE] Connection error — will retry');
    });

    it('should display disconnected status on "disconnected" state', () => {
      capturedConnectionStateHandler!('disconnected');

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls).toContainEqual('[SSE] Disconnected');
    });

    it('should not display status after dispose', () => {
      const handler = capturedConnectionStateHandler!;
      JobLogChannel.disposeAll();
      mockOutputChannel.appendLine.mockClear();

      handler('connecting');

      expect(mockOutputChannel.appendLine).not.toHaveBeenCalled();
    });

    it('should dispose connection state listener on job:log:end', () => {
      capturedSSEHandler!(createSSEEvent({
        event: 'job:log:end',
        data: { jobId: JOB_ID, status: 'completed' },
      }));

      expect(mockConnectionStateDisposable.dispose).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Error handling and retry logic
  // =========================================================================

  describe('error handling and retries', () => {
    it('should retry on fetch failure with increasing backoff', async () => {
      const fetchError = new Error('Network error');
      mockGetJobLogs
        .mockRejectedValueOnce(fetchError)       // initial call fails
        .mockRejectedValueOnce(fetchError)       // retry 1 fails (retryCount becomes 1)
        .mockRejectedValueOnce(fetchError)       // retry 2 fails (retryCount becomes 2)
        .mockRejectedValueOnce(fetchError);      // retry 3 fails (retryCount becomes 3 = MAX_RETRIES)

      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      // First call failed — error message + retry notice
      let calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls.some((c: string) => c.includes('Failed to load historical logs: Network error'))).toBe(true);
      expect(calls.some((c: string) => c.includes('Retrying in 5s (attempt 1/3)'))).toBe(true);

      // Advance timer for first retry (5s)
      mockOutputChannel.appendLine.mockClear();
      await vi.advanceTimersByTimeAsync(5_000);

      calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls.some((c: string) => c.includes('Retrying in 10s (attempt 2/3)'))).toBe(true);

      // Advance timer for second retry (10s)
      mockOutputChannel.appendLine.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);

      calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls.some((c: string) => c.includes('Retrying in 20s (attempt 3/3)'))).toBe(true);

      // Advance timer for third retry (20s) — should hit MAX_RETRIES
      mockOutputChannel.appendLine.mockClear();
      await vi.advanceTimersByTimeAsync(20_000);

      calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls.some((c: string) => c.includes('Failed to load historical logs after 3 attempts'))).toBe(true);
    });

    it('should not retry after dispose', async () => {
      mockGetJobLogs.mockRejectedValueOnce(new Error('Network error'));

      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      // Dispose the channel before the retry fires
      JobLogChannel.disposeAll();

      // Advance timer past the retry delay
      await vi.advanceTimersByTimeAsync(5_000);

      // getJobLogs should only have been called once (no retry after dispose)
      expect(mockGetJobLogs).toHaveBeenCalledTimes(1);
    });

    it('should log error to logger', async () => {
      const error = new Error('API unavailable');
      mockGetJobLogs.mockRejectedValueOnce(error);
      mockLogger.error.mockClear();

      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      expect(mockLogger.error).toHaveBeenCalledWith(
        `Failed to fetch logs for job ${JOB_ID}`,
        error
      );
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe('dispose', () => {
    it('should dispose output channel and SSE subscription', async () => {
      mockGetJobLogs.mockResolvedValueOnce(createLogsResponse());
      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      JobLogChannel.disposeAll();

      expect(mockOutputChannel.dispose).toHaveBeenCalled();
      expect(mockSSEDisposable.dispose).toHaveBeenCalled();
    });

    it('should clear retry timer on dispose', async () => {
      mockGetJobLogs.mockRejectedValueOnce(new Error('fail'));
      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      // A retry timer is now pending
      JobLogChannel.disposeAll();

      // Advance timers — the retry should NOT fire
      mockGetJobLogs.mockClear();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mockGetJobLogs).not.toHaveBeenCalled();
    });

    it('should ignore SSE events after dispose', async () => {
      mockGetJobLogs.mockResolvedValueOnce(createLogsResponse());
      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      const handler = capturedSSEHandler!;
      JobLogChannel.disposeAll();
      mockOutputChannel.appendLine.mockClear();

      // Fire an event after dispose — should be silently ignored
      handler(createSSEEvent({
        event: 'job:log',
        data: {
          jobId: JOB_ID,
          content: 'after dispose',
          stream: 'stdout',
          timestamp: '2026-02-23T12:02:00.000Z',
        },
      }));

      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls.some((c: string) => c?.includes?.('after dispose'))).toBe(false);
    });

    it('should remove channel from activeChannels map', async () => {
      mockGetJobLogs.mockResolvedValue(createLogsResponse());

      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);
      JobLogChannel.disposeAll();

      // Opening again should create a new channel
      const vscode = await import('vscode');
      (vscode.window.createOutputChannel as ReturnType<typeof vi.fn>).mockClear();

      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);
      expect(vscode.window.createOutputChannel).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // disposeAll
  // =========================================================================

  describe('disposeAll', () => {
    it('should dispose all active channels', async () => {
      mockGetJobLogs.mockResolvedValue(createLogsResponse());

      await JobLogChannel.openJobLogs('job-1', 'workflow-1');
      await JobLogChannel.openJobLogs('job-2', 'workflow-2');

      // outputChannel.dispose is shared mock, but we can verify it was called
      mockOutputChannel.dispose.mockClear();
      JobLogChannel.disposeAll();

      expect(mockOutputChannel.dispose).toHaveBeenCalledTimes(2);
    });

    it('should be safe to call when no channels are active', () => {
      expect(() => JobLogChannel.disposeAll()).not.toThrow();
    });
  });

  // =========================================================================
  // SSE subscription lifecycle
  // =========================================================================

  describe('SSE subscription lifecycle', () => {
    it('should dispose previous SSE subscription when re-opening', async () => {
      mockGetJobLogs.mockResolvedValue(createLogsResponse());

      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      // First subscription exists
      expect(mockSSESubscribe).toHaveBeenCalledTimes(1);

      // Re-open the same channel
      mockSSEDisposable.dispose.mockClear();
      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      // Previous SSE subscription should have been disposed before re-subscribing
      expect(mockSSEDisposable.dispose).toHaveBeenCalled();
      expect(mockSSESubscribe).toHaveBeenCalledTimes(2);
    });

    it('should reset retryCount when re-opening', async () => {
      // First open fails, starting retry cycle
      mockGetJobLogs.mockRejectedValueOnce(new Error('fail'));
      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      // Re-open before retry fires — retryCount should be reset
      mockGetJobLogs.mockResolvedValueOnce(createLogsResponse());
      await JobLogChannel.openJobLogs(JOB_ID, WORKFLOW_NAME);

      // The historical fetch should succeed now
      const calls = mockOutputChannel.appendLine.mock.calls.map((c: unknown[]) => c[0]);
      const liveBanner = calls.filter((c: string) => c.includes('Live log stream active'));
      expect(liveBanner.length).toBeGreaterThanOrEqual(1);
    });
  });
});
