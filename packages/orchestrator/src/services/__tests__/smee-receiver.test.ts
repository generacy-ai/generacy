import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { SmeeWebhookReceiver } from '../smee-receiver.js';
import type { LabelMonitorService } from '../label-monitor-service.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/**
 * Equal-jitter band for `calculateBackoffDelay(attempt, { base, cap: 30_000 })`:
 *   raw    = base * 2^attempt
 *   capped = min(raw, 30_000)
 *   band   = [capped / 2, capped)
 */
function backoffBand(base: number, attempt: number): { min: number; max: number } {
  const raw = base * Math.pow(2, attempt);
  const capped = Math.min(raw, 30_000);
  return { min: capped / 2, max: capped };
}

function expectBackoffAttempt(
  msg: unknown,
  attempt: number,
  base: number,
): void {
  const { min, max } = backoffBand(base, attempt);
  const m = msg as { attempt: number; reconnectMs: number };
  expect(m.attempt).toBe(attempt);
  expect(m.reconnectMs).toBeGreaterThanOrEqual(min);
  expect(m.reconnectMs).toBeLessThan(max);
}

describe('SmeeWebhookReceiver', () => {
  let receiver: SmeeWebhookReceiver;
  let mockLogger: {
    info: Mock;
    warn: Mock;
    error: Mock;
  };
  let mockMonitorService: LabelMonitorService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    // Create mock logger
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    // Create mock monitor service
    mockMonitorService = {
      parseLabelEvent: vi.fn(),
      recordWebhookEvent: vi.fn(),
      processLabelEvent: vi.fn(),
      verifyAndProcessCompletedLabel: vi.fn(),
    } as unknown as LabelMonitorService;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('exponential backoff', () => {
    it('should use default base reconnect delay of 5 seconds', async () => {
      // Arrange
      receiver = new SmeeWebhookReceiver(mockLogger, mockMonitorService, {
        channelUrl: 'https://smee.io/test',
        watchedRepos: new Set(['owner/repo']),
      });

      // Mock fetch to fail immediately
      mockFetch.mockRejectedValueOnce(new Error('Connection failed'));

      // Act - start the receiver (will fail and try to reconnect)
      const startPromise = receiver.start();

      // Let the first connection attempt fail
      await vi.advanceTimersByTimeAsync(100);

      // Stop before reconnect
      receiver.stop();
      await startPromise;

      // Assert - default base=5000 → attempt=0 delay in [2500, 5000)
      const warnCall = mockLogger.warn.mock.calls.find(
        (call) => call[1] === 'Smee connection lost, reconnecting...',
      );
      expect(warnCall).toBeDefined();
      expectBackoffAttempt(warnCall![0], 0, 5000);
    });

    it('should use custom base reconnect delay when provided', async () => {
      // Arrange - custom 10 second base delay
      receiver = new SmeeWebhookReceiver(mockLogger, mockMonitorService, {
        channelUrl: 'https://smee.io/test',
        watchedRepos: new Set(['owner/repo']),
        baseReconnectDelayMs: 10000,
      });

      mockFetch.mockRejectedValueOnce(new Error('Connection failed'));

      // Act
      const startPromise = receiver.start();
      await vi.advanceTimersByTimeAsync(100);
      receiver.stop();
      await startPromise;

      // Assert - custom base=10000 → attempt=0 delay in [5000, 10000)
      const warnCall = mockLogger.warn.mock.calls.find(
        (call) => call[1] === 'Smee connection lost, reconnecting...',
      );
      expect(warnCall).toBeDefined();
      expectBackoffAttempt(warnCall![0], 0, 10000);
    });

    it('should exponentially increase delay on consecutive failures', async () => {
      // Arrange
      receiver = new SmeeWebhookReceiver(mockLogger, mockMonitorService, {
        channelUrl: 'https://smee.io/test',
        watchedRepos: new Set(['owner/repo']),
        baseReconnectDelayMs: 5000,
      });

      // Mock fetch to fail 6 times
      mockFetch.mockRejectedValue(new Error('Connection failed'));

      // Act - start and let it fail multiple times
      receiver.start();

      // Let first connection attempt complete
      await vi.advanceTimersByTimeAsync(0);

      // Advance through each reconnect cycle
      await vi.advanceTimersByTimeAsync(5000);   // First reconnect after 5s
      await vi.advanceTimersByTimeAsync(10000);  // Second reconnect after 10s
      await vi.advanceTimersByTimeAsync(20000);  // Third reconnect after 20s
      await vi.advanceTimersByTimeAsync(40000);  // Fourth reconnect after 40s
      await vi.advanceTimersByTimeAsync(80000);  // Fifth reconnect after 80s

      // Assert - check all warn calls for the exponential backoff sequence
      const warnCalls = mockLogger.warn.mock.calls.filter(call =>
        call[1] === 'Smee connection lost, reconnecting...'
      );

      expect(warnCalls.length).toBeGreaterThanOrEqual(5);
      // With base=5000, cap=30_000: bands per attempt:
      //   0 → [2500, 5000), 1 → [5000, 10000), 2 → [10000, 20000),
      //   3+ → [15000, 30000) (capped).
      expectBackoffAttempt(warnCalls[0][0], 0, 5000);
      expectBackoffAttempt(warnCalls[1][0], 1, 5000);
      expectBackoffAttempt(warnCalls[2][0], 2, 5000);
      expectBackoffAttempt(warnCalls[3][0], 3, 5000);
      expectBackoffAttempt(warnCalls[4][0], 4, 5000);

      // Stop the receiver
      receiver.stop();
    });

    it('should cap backoff delay at 30s', async () => {
      // Arrange
      receiver = new SmeeWebhookReceiver(mockLogger, mockMonitorService, {
        channelUrl: 'https://smee.io/test',
        watchedRepos: new Set(['owner/repo']),
        baseReconnectDelayMs: 5000,
      });

      mockFetch.mockRejectedValue(new Error('Connection failed'));

      // Act - start and let it fail many times
      receiver.start();

      // Let first connection attempt complete
      await vi.advanceTimersByTimeAsync(0);

      // Advance through reconnect cycles. Each advance must exceed the
      // upper bound of the current attempt's jitter band (cap=30_000).
      await vi.advanceTimersByTimeAsync(30_000); // attempt 1 sleep
      await vi.advanceTimersByTimeAsync(30_000); // attempt 2 sleep
      await vi.advanceTimersByTimeAsync(30_000); // attempt 3 sleep
      await vi.advanceTimersByTimeAsync(30_000); // attempt 4 sleep
      await vi.advanceTimersByTimeAsync(30_000); // attempt 5 sleep
      await vi.advanceTimersByTimeAsync(30_000); // attempt 6 sleep
      await vi.advanceTimersByTimeAsync(30_000); // attempt 7 sleep (still capped)

      // Assert - check that backoff is capped at 30s
      const warnCalls = mockLogger.warn.mock.calls.filter(call =>
        call[1] === 'Smee connection lost, reconnecting...'
      );

      expect(warnCalls.length).toBeGreaterThanOrEqual(7);
      // Bands (base=5000, cap=30000):
      //   attempt 0 → [2500, 5000), 1 → [5000, 10000), 2 → [10000, 20000),
      //   attempt 3+ → [15000, 30000) capped.
      for (let i = 0; i < 7; i++) {
        expectBackoffAttempt(warnCalls[i][0], i, 5000);
      }
      // Explicit cap assertions for attempts >= 3.
      for (let i = 3; i < 7; i++) {
        expect((warnCalls[i][0] as { reconnectMs: number }).reconnectMs).toBeLessThan(30_000);
      }

      // Stop the receiver
      receiver.stop();
    });

    it('should reset backoff counter on successful connection', async () => {
      // Arrange
      receiver = new SmeeWebhookReceiver(mockLogger, mockMonitorService, {
        channelUrl: 'https://smee.io/test',
        watchedRepos: new Set(['owner/repo']),
        baseReconnectDelayMs: 5000,
      });

      // Mock a successful connection that ends after some time
      const mockBody = {
        getReader: () => ({
          read: vi.fn()
            .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('data: test\n\n') })
            .mockResolvedValueOnce({ done: true, value: undefined }),
          releaseLock: vi.fn(),
        }),
      };

      // First fail twice, then succeed, then fail again
      mockFetch
        .mockRejectedValueOnce(new Error('First failure'))
        .mockRejectedValueOnce(new Error('Second failure'))
        .mockResolvedValueOnce({ ok: true, body: mockBody } as unknown as Response)
        .mockRejectedValueOnce(new Error('Third failure'));

      // Act
      receiver.start();

      // First failure
      await vi.advanceTimersByTimeAsync(0);
      // Advance past attempt-0 sleep band [2500, 5000)
      await vi.advanceTimersByTimeAsync(10000);
      // Advance past attempt-1 sleep band [5000, 10000)
      await vi.advanceTimersByTimeAsync(20000);
      // Success -> let connection complete
      await vi.advanceTimersByTimeAsync(0);

      // Assert - check the warning sequence
      const warnCalls = mockLogger.warn.mock.calls.filter(call =>
        call[1] === 'Smee connection lost, reconnecting...'
      );

      // First two failures with increasing backoff band
      expect(warnCalls.length).toBeGreaterThanOrEqual(2);
      expectBackoffAttempt(warnCalls[0][0], 0, 5000);
      expectBackoffAttempt(warnCalls[1][0], 1, 5000);

      // After successful connection, if it fails again, backoff should reset
      if (warnCalls.length >= 3) {
        expectBackoffAttempt(warnCalls[2][0], 0, 5000);
      }

      // Should log successful connection
      expect(mockLogger.info).toHaveBeenCalledWith('Connected to smee.io channel');

      // Stop the receiver
      receiver.stop();
    });

    it('should calculate correct backoff for custom base delay', async () => {
      // Arrange - 2 second base delay
      receiver = new SmeeWebhookReceiver(mockLogger, mockMonitorService, {
        channelUrl: 'https://smee.io/test',
        watchedRepos: new Set(['owner/repo']),
        baseReconnectDelayMs: 2000,
      });

      mockFetch.mockRejectedValue(new Error('Connection failed'));

      // Act
      const startPromise = receiver.start();

      // Equal-jitter progression with base=2000, cap=30_000:
      //   attempt 0 → [1000, 2000)
      //   attempt 1 → [2000, 4000)
      //   attempt 2 → [4000, 8000)
      //   attempt 3 → [8000, 16000)
      //   attempt 4+ → [15000, 30000) capped (raw=32000 > 30000)
      // Advance by 30_000 per iteration — guaranteed > band upper bound.
      const iterations = 6;

      // Process first fetch rejection to trigger the first warn + sleep
      await vi.advanceTimersByTimeAsync(0);

      for (let attempt = 0; attempt < iterations; attempt++) {
        const warnCalls = mockLogger.warn.mock.calls.filter(
          (call) => call[1] === 'Smee connection lost, reconnecting...',
        );
        expect(warnCalls.length).toBeGreaterThanOrEqual(attempt + 1);
        expectBackoffAttempt(warnCalls[attempt][0], attempt, 2000);

        if (attempt < iterations - 1) {
          await vi.advanceTimersByTimeAsync(30_000);
        }
      }

      // Stop the receiver
      receiver.stop();
      await startPromise;
    });

    it('should not reconnect when stopped during backoff delay', async () => {
      // Arrange
      receiver = new SmeeWebhookReceiver(mockLogger, mockMonitorService, {
        channelUrl: 'https://smee.io/test',
        watchedRepos: new Set(['owner/repo']),
        baseReconnectDelayMs: 5000,
      });

      mockFetch.mockRejectedValue(new Error('Connection failed'));

      // Act
      receiver.start();

      // First failure
      await vi.advanceTimersByTimeAsync(0);

      const warnCallsBefore = mockLogger.warn.mock.calls.length;
      const fetchCallsBefore = mockFetch.mock.calls.length;

      // Stop during the 5 second backoff delay (should abort the sleep)
      receiver.stop();
      await vi.advanceTimersByTimeAsync(5000);

      // Assert - should not log another warning or attempt another connection
      const warnCallsAfter = mockLogger.warn.mock.calls.length;
      const fetchCallsAfter = mockFetch.mock.calls.length;

      expect(warnCallsAfter).toBe(warnCallsBefore);
      expect(fetchCallsAfter).toBe(fetchCallsBefore);
      expect(mockLogger.info).toHaveBeenCalledWith('Smee receiver stop requested');
      expect(mockLogger.info).toHaveBeenCalledWith('Smee receiver stopped');
    });

    it('should handle abort signal during sleep', async () => {
      // Arrange
      receiver = new SmeeWebhookReceiver(mockLogger, mockMonitorService, {
        channelUrl: 'https://smee.io/test',
        watchedRepos: new Set(['owner/repo']),
        baseReconnectDelayMs: 10000,
      });

      mockFetch.mockRejectedValue(new Error('Connection failed'));

      // Act
      const startPromise = receiver.start();

      // First failure triggers 10s backoff
      await vi.advanceTimersByTimeAsync(100);

      // Stop immediately (abort signal should resolve sleep early)
      receiver.stop();
      await vi.advanceTimersByTimeAsync(100);

      await startPromise;

      // Assert - should stop cleanly without waiting full 10s
      expect(mockLogger.info).toHaveBeenCalledWith('Smee receiver stopped');
    });

    it('should handle connection that succeeds but immediately errors', async () => {
      // Arrange
      receiver = new SmeeWebhookReceiver(mockLogger, mockMonitorService, {
        channelUrl: 'https://smee.io/test',
        watchedRepos: new Set(['owner/repo']),
        baseReconnectDelayMs: 5000,
      });

      // Mock connection that throws during setup
      mockFetch
        .mockRejectedValueOnce(new Error('First failure'))
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Internal Server Error' } as Response)
        .mockRejectedValueOnce(new Error('Third failure'));

      // Act
      receiver.start();

      // First failure
      await vi.advanceTimersByTimeAsync(0);
      // Fire only the pending attempt-0 sleep (jitter-band [2500, 5000)) →
      // attempt 1 fetch fires (500 error path).
      await vi.runOnlyPendingTimersAsync();
      await vi.advanceTimersByTimeAsync(0);
      // Fire only the pending attempt-1 sleep → attempt 2 fires (third failure).
      await vi.runOnlyPendingTimersAsync();
      await vi.advanceTimersByTimeAsync(0);

      // Assert - all failures should increment backoff
      const warnCalls = mockLogger.warn.mock.calls.filter(call =>
        call[1] === 'Smee connection lost, reconnecting...'
      );

      expect(warnCalls.length).toBe(3);
      expectBackoffAttempt(warnCalls[0][0], 0, 5000);
      expectBackoffAttempt(warnCalls[1][0], 1, 5000);
      expectBackoffAttempt(warnCalls[2][0], 2, 5000);

      receiver.stop();
    });

    it('should handle response without body', async () => {
      // Arrange
      receiver = new SmeeWebhookReceiver(mockLogger, mockMonitorService, {
        channelUrl: 'https://smee.io/test',
        watchedRepos: new Set(['owner/repo']),
        baseReconnectDelayMs: 5000,
      });

      // Mock response without body - need 3 calls because the first 2 happen in quick succession
      mockFetch
        .mockResolvedValueOnce({ ok: true, body: null } as unknown as Response)
        .mockRejectedValueOnce(new Error('Second failure'))
        .mockRejectedValueOnce(new Error('Third failure'));

      // Act
      receiver.start();

      // First failure (no body)
      await vi.advanceTimersByTimeAsync(0);
      // Advance past attempt-0 sleep band [2500, 5000) → attempt 1 fires
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(0);

      // Assert - both failures should increment backoff
      const warnCalls = mockLogger.warn.mock.calls.filter(call =>
        call[1] === 'Smee connection lost, reconnecting...'
      );

      expect(warnCalls.length).toBeGreaterThanOrEqual(2);
      expect(warnCalls[0][0]).toMatchObject({
        err: 'Error: Smee response has no body',
      });
      expectBackoffAttempt(warnCalls[0][0], 0, 5000);
      expectBackoffAttempt(warnCalls[1][0], 1, 5000);

      receiver.stop();
    });
  });

  describe('connection lifecycle', () => {
    it('should warn when already running', async () => {
      // Arrange
      receiver = new SmeeWebhookReceiver(mockLogger, mockMonitorService, {
        channelUrl: 'https://smee.io/test',
        watchedRepos: new Set(['owner/repo']),
      });

      const mockBody = {
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: false, value: new Uint8Array() }),
          releaseLock: vi.fn(),
        }),
      };

      mockFetch.mockResolvedValue({ ok: true, body: mockBody } as unknown as Response);

      // Act - start twice
      const startPromise1 = receiver.start();
      await vi.advanceTimersByTimeAsync(100);

      receiver.start(); // Start again while running

      // Assert
      expect(mockLogger.warn).toHaveBeenCalledWith('Smee receiver already running');

      // Cleanup
      receiver.stop();
      await startPromise1;
    });

    it('should log startup and shutdown messages', async () => {
      // Arrange
      receiver = new SmeeWebhookReceiver(mockLogger, mockMonitorService, {
        channelUrl: 'https://smee.io/test',
        watchedRepos: new Set(['owner/repo']),
      });

      mockFetch.mockRejectedValue(new Error('Connection failed'));

      // Act
      const startPromise = receiver.start();
      await vi.advanceTimersByTimeAsync(100);

      // Assert startup log
      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          channelUrl: 'https://smee.io/test',
          watchedRepos: ['owner/repo'],
        },
        'Starting smee.io webhook receiver'
      );

      // Stop
      receiver.stop();
      await startPromise;

      // Assert shutdown logs
      expect(mockLogger.info).toHaveBeenCalledWith('Smee receiver stop requested');
      expect(mockLogger.info).toHaveBeenCalledWith('Smee receiver stopped');
    });
  });
});
