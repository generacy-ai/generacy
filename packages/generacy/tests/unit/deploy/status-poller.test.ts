import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('node:http', () => ({
  default: { request: vi.fn() },
  request: vi.fn(),
}));

vi.mock('node:https', () => ({
  default: { request: vi.fn() },
  request: vi.fn(),
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock('../../../src/cli/utils/logger.js', () => ({
  getLogger: () => mockLogger,
}));

import http from 'node:http';
import { pollClusterStatus } from '../../../src/cli/commands/deploy/status-poller.js';
import { DeployError } from '../../../src/cli/commands/deploy/types.js';

// --- Helpers ---

/**
 * Creates a mock response object whose `on` handler fires data+end
 * synchronously when attached, so the Promise inside fetchClusterStatus
 * resolves without needing real event-loop ticks.
 */
function createSyncMockResponse(body: Record<string, unknown>) {
  const json = JSON.stringify(body);
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      // When 'end' is registered, fire data then end synchronously.
      // This works because node:http wires data before end.
      if (event === 'end') {
        for (const h of handlers['data'] ?? []) h(Buffer.from(json));
        for (const h of handlers['end'] ?? []) h();
      }
    },
  };
}

/**
 * Configure the http.request mock to invoke its callback synchronously
 * with the given response bodies in sequence.
 */
function setupHttpResponses(responses: Array<Record<string, unknown> | 'error'>): void {
  let callIndex = 0;
  (http.request as ReturnType<typeof vi.fn>).mockImplementation(
    (_opts: unknown, callback?: (res: unknown) => void) => {
      const entry = responses[callIndex++] ?? { status: 'pending' };
      const req = {
        end: vi.fn(),
        destroy: vi.fn(),
        setTimeout: vi.fn(),
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
          if (event === 'error' && entry === 'error') {
            // Fire error synchronously
            handler(new Error('connection refused'));
          }
        }),
      };

      if (entry !== 'error' && callback) {
        callback(createSyncMockResponse(entry));
      }

      return req;
    },
  );
}

// --- Tests ---

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pollClusterStatus', () => {
  const CLOUD_URL = 'http://localhost:9000';
  const CLUSTER_ID = 'cl-test-123';
  const API_KEY = 'test-api-key';

  it('returns immediately when first status check returns connected', async () => {
    setupHttpResponses([{ status: 'connected' }]);

    const promise = pollClusterStatus(CLOUD_URL, CLUSTER_ID, API_KEY, 30_000);

    // Advance past the initial interval (3000ms)
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(promise).resolves.toBeUndefined();
    expect(mockLogger.info).toHaveBeenCalledWith('Cluster status: connected');
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it('polls multiple times until connected is returned', async () => {
    setupHttpResponses([
      { status: 'pending' },
      { status: 'provisioning' },
      { status: 'connected' },
    ]);

    const promise = pollClusterStatus(CLOUD_URL, CLUSTER_ID, API_KEY, 60_000);

    // Poll 1 at 3000ms
    await vi.advanceTimersByTimeAsync(3_000);
    // Poll 2: interval = min(3000*1.5, 15000) = 4500ms
    await vi.advanceTimersByTimeAsync(4_500);
    // Poll 3: interval = min(4500*1.5, 15000) = 6750ms
    await vi.advanceTimersByTimeAsync(6_750);

    await expect(promise).resolves.toBeUndefined();
    expect(http.request).toHaveBeenCalledTimes(3);
    expect(mockLogger.info).toHaveBeenCalledWith('Cluster status: pending');
    expect(mockLogger.info).toHaveBeenCalledWith('Cluster status: provisioning');
    expect(mockLogger.info).toHaveBeenCalledWith('Cluster status: connected');
  });

  it('throws DeployError with REGISTRATION_TIMEOUT when timeout expires', async () => {
    // Provide enough responses to cover all polls within the timeout window
    setupHttpResponses(
      Array.from({ length: 20 }, () => ({ status: 'pending' })),
    );

    const timeoutMs = 10_000;
    const promise = pollClusterStatus(CLOUD_URL, CLUSTER_ID, API_KEY, timeoutMs);

    // Attach the catch handler before advancing timers so the rejection
    // is handled synchronously and does not surface as an unhandled rejection.
    const resultPromise = promise.then(
      () => { throw new Error('should have thrown'); },
      (err: unknown) => err,
    );

    // Advance well past the timeout so the while loop exits
    await vi.advanceTimersByTimeAsync(60_000);

    const err = await resultPromise;
    expect(err).toBeInstanceOf(DeployError);
    expect((err as DeployError).code).toBe('REGISTRATION_TIMEOUT');
    expect((err as DeployError).message).toContain(`${Math.round(timeoutMs / 1000)}s`);
    expect((err as DeployError).message).toContain(CLUSTER_ID);
  });

  it('continues polling when status is not connected', async () => {
    setupHttpResponses([
      { status: 'pending' },
      { status: 'provisioning' },
      { status: 'starting' },
      { status: 'connected' },
    ]);

    const promise = pollClusterStatus(CLOUD_URL, CLUSTER_ID, API_KEY, 120_000);

    // Advance through all four polls with exponential backoff
    // Poll 1: 3000ms
    await vi.advanceTimersByTimeAsync(3_000);
    // Poll 2: 4500ms
    await vi.advanceTimersByTimeAsync(4_500);
    // Poll 3: 6750ms
    await vi.advanceTimersByTimeAsync(6_750);
    // Poll 4: 10125ms
    await vi.advanceTimersByTimeAsync(10_125);

    await expect(promise).resolves.toBeUndefined();
    expect(http.request).toHaveBeenCalledTimes(4);
    // Verify each non-connected status was logged
    expect(mockLogger.info).toHaveBeenCalledWith('Cluster status: pending');
    expect(mockLogger.info).toHaveBeenCalledWith('Cluster status: provisioning');
    expect(mockLogger.info).toHaveBeenCalledWith('Cluster status: starting');
    expect(mockLogger.info).toHaveBeenCalledWith('Cluster status: connected');
  });

  it('continues polling when individual status checks fail', async () => {
    setupHttpResponses([
      'error',
      'error',
      { status: 'connected' },
    ]);

    const promise = pollClusterStatus(CLOUD_URL, CLUSTER_ID, API_KEY, 60_000);

    // Poll 1: 3000ms — error
    await vi.advanceTimersByTimeAsync(3_000);
    // Poll 2: 4500ms — error
    await vi.advanceTimersByTimeAsync(4_500);
    // Poll 3: 6750ms — connected
    await vi.advanceTimersByTimeAsync(6_750);

    await expect(promise).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Status check failed'),
    );
    expect(mockLogger.info).toHaveBeenCalledWith('Cluster status: connected');
  });
});
