import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { SmeeWebhookReceiver } from '../smee-receiver.js';
import type { LabelMonitorService } from '../label-monitor-service.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

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

      // Assert - should warn with default 5 second delay
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          reconnectMs: 5000,
          attempt: 0,
        }),
        'Smee connection lost, reconnecting...'
      );
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

      // Assert - should use custom base delay
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          reconnectMs: 10000,
          attempt: 0,
        }),
        'Smee connection lost, reconnecting...'
      );
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
      expect(warnCalls[0][0]).toMatchObject({ attempt: 0, reconnectMs: 5000 });
      expect(warnCalls[1][0]).toMatchObject({ attempt: 1, reconnectMs: 10000 });
      expect(warnCalls[2][0]).toMatchObject({ attempt: 2, reconnectMs: 20000 });
      expect(warnCalls[3][0]).toMatchObject({ attempt: 3, reconnectMs: 40000 });
      expect(warnCalls[4][0]).toMatchObject({ attempt: 4, reconnectMs: 80000 });

      // Stop the receiver
      receiver.stop();
    });

    it('should cap backoff delay at 5 minutes (300s)', async () => {
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

      // Advance through reconnect cycles to reach and exceed the cap
      await vi.advanceTimersByTimeAsync(5000);    // attempt 1: 5s
      await vi.advanceTimersByTimeAsync(10000);   // attempt 2: 10s
      await vi.advanceTimersByTimeAsync(20000);   // attempt 3: 20s
      await vi.advanceTimersByTimeAsync(40000);   // attempt 4: 40s
      await vi.advanceTimersByTimeAsync(80000);   // attempt 5: 80s
      await vi.advanceTimersByTimeAsync(160000);  // attempt 6: 160s
      await vi.advanceTimersByTimeAsync(300000);  // attempt 7: 300s (capped)

      // Assert - check that backoff is capped at 300s
      const warnCalls = mockLogger.warn.mock.calls.filter(call =>
        call[1] === 'Smee connection lost, reconnecting...'
      );

      expect(warnCalls.length).toBeGreaterThanOrEqual(7);
      expect(warnCalls[0][0]).toMatchObject({ attempt: 0, reconnectMs: 5000 });
      expect(warnCalls[1][0]).toMatchObject({ attempt: 1, reconnectMs: 10000 });
      expect(warnCalls[2][0]).toMatchObject({ attempt: 2, reconnectMs: 20000 });
      expect(warnCalls[3][0]).toMatchObject({ attempt: 3, reconnectMs: 40000 });
      expect(warnCalls[4][0]).toMatchObject({ attempt: 4, reconnectMs: 80000 });
      expect(warnCalls[5][0]).toMatchObject({ attempt: 5, reconnectMs: 160000 });
      expect(warnCalls[6][0]).toMatchObject({ attempt: 6, reconnectMs: 300000 }); // Capped

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
      // Wait 5s and reconnect (second failure)
      await vi.advanceTimersByTimeAsync(5000);
      // Wait 10s and reconnect (success)
      await vi.advanceTimersByTimeAsync(10000);
      // Success -> let connection complete
      await vi.advanceTimersByTimeAsync(0);

      // Assert - check the warning sequence
      const warnCalls = mockLogger.warn.mock.calls.filter(call =>
        call[1] === 'Smee connection lost, reconnecting...'
      );

      // First two failures with increasing backoff
      expect(warnCalls.length).toBeGreaterThanOrEqual(2);
      expect(warnCalls[0][0]).toMatchObject({ attempt: 0, reconnectMs: 5000 });
      expect(warnCalls[1][0]).toMatchObject({ attempt: 1, reconnectMs: 10000 });

      // After successful connection, if it fails again, backoff should reset
      if (warnCalls.length >= 3) {
        expect(warnCalls[2][0]).toMatchObject({ attempt: 0, reconnectMs: 5000 });
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

      // Test progression: 2s → 4s → 8s → 16s → 32s → 64s → 128s → 256s → 300s (capped)
      const expectedDelays = [
        { attempt: 0, delay: 2000 },
        { attempt: 1, delay: 4000 },
        { attempt: 2, delay: 8000 },
        { attempt: 3, delay: 16000 },
        { attempt: 4, delay: 32000 },
        { attempt: 5, delay: 64000 },
        { attempt: 6, delay: 128000 },
        { attempt: 7, delay: 256000 },
        { attempt: 8, delay: 300000 }, // Capped
      ];

      for (const { attempt, delay } of expectedDelays) {
        await vi.runOnlyPendingTimersAsync();
        expect(mockLogger.warn).toHaveBeenLastCalledWith(
          expect.objectContaining({
            reconnectMs: delay,
            attempt,
          }),
          'Smee connection lost, reconnecting...'
        );

        if (attempt < expectedDelays.length - 1) {
          await vi.advanceTimersByTimeAsync(delay);
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
      // Wait 5s and reconnect (500 error)
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);
      // Wait 10s and reconnect (third failure)
      await vi.advanceTimersByTimeAsync(10000);
      await vi.advanceTimersByTimeAsync(0);

      // Assert - all failures should increment backoff
      const warnCalls = mockLogger.warn.mock.calls.filter(call =>
        call[1] === 'Smee connection lost, reconnecting...'
      );

      expect(warnCalls.length).toBe(3);
      expect(warnCalls[0][0]).toMatchObject({ attempt: 0, reconnectMs: 5000 });
      expect(warnCalls[1][0]).toMatchObject({ attempt: 1, reconnectMs: 10000 });
      expect(warnCalls[2][0]).toMatchObject({ attempt: 2, reconnectMs: 20000 });

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
      // Wait 5s and reconnect (second failure)
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(0);

      // Assert - both failures should increment backoff
      const warnCalls = mockLogger.warn.mock.calls.filter(call =>
        call[1] === 'Smee connection lost, reconnecting...'
      );

      expect(warnCalls.length).toBeGreaterThanOrEqual(2);
      expect(warnCalls[0][0]).toMatchObject({
        err: 'Error: Smee response has no body',
        reconnectMs: 5000,
        attempt: 0,
      });
      expect(warnCalls[1][0]).toMatchObject({
        reconnectMs: 10000,
        attempt: 1,
      });

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
