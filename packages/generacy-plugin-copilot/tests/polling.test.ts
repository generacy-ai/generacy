/**
 * @generacy-ai/generacy-plugin-copilot
 *
 * Polling and backoff tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StatusPoller, createStatusPoller } from '../src/polling/status-poller.js';
import { PollingTimeoutError } from '../src/errors.js';
import type { WorkspaceStatus } from '../src/types.js';

describe('StatusPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('pollOnce', () => {
    it('should poll status once', async () => {
      const poller = new StatusPoller('ws_test');
      const checkStatus = vi.fn().mockResolvedValue('pending' as WorkspaceStatus);

      const status = await poller.pollOnce(checkStatus);

      expect(status).toBe('pending');
      expect(checkStatus).toHaveBeenCalledTimes(1);
    });
  });

  describe('pollUntilTerminal', () => {
    it('should poll until terminal status', async () => {
      vi.useRealTimers(); // Use real timers for this test

      const poller = new StatusPoller('ws_test', {
        initialIntervalMs: 10, // Very short interval for testing
        maxRetries: 10,
      });

      let callCount = 0;
      const statuses: WorkspaceStatus[] = ['pending', 'planning', 'implementing', 'merged'];
      const checkStatus = vi.fn().mockImplementation(async () => {
        return statuses[callCount++] ?? 'merged';
      });

      const result = await poller.pollUntilTerminal(checkStatus);

      expect(result.status).toBe('merged');
      expect(result.isTerminal).toBe(true);
      expect(result.pollCount).toBeGreaterThanOrEqual(1);

      vi.useFakeTimers(); // Restore for other tests
    });

    it('should call onStatusChange callback when status changes', async () => {
      const poller = new StatusPoller('ws_test', {
        initialIntervalMs: 100,
        maxRetries: 10,
      });

      let callCount = 0;
      const statuses: WorkspaceStatus[] = ['pending', 'planning', 'merged'];
      const checkStatus = vi.fn().mockImplementation(async () => {
        return statuses[callCount++] ?? 'merged';
      });
      const onStatusChange = vi.fn();

      const promise = poller.pollUntilTerminal(checkStatus, onStatusChange);

      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }

      await promise;

      expect(onStatusChange).toHaveBeenCalledWith('planning', 'pending');
      expect(onStatusChange).toHaveBeenCalledWith('merged', 'planning');
    });

    it('should respect max retries', async () => {
      const poller = new StatusPoller('ws_test', {
        initialIntervalMs: 100,
        maxRetries: 3,
      });

      const checkStatus = vi.fn().mockResolvedValue('pending' as WorkspaceStatus);

      const promise = poller.pollUntilTerminal(checkStatus);

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }

      const result = await promise;

      expect(checkStatus).toHaveBeenCalledTimes(3);
      expect(result.isTerminal).toBe(false);
    });

    it('should throw on timeout', async () => {
      vi.useRealTimers(); // Use real timers for this test

      const poller = new StatusPoller('ws_test', {
        initialIntervalMs: 10,
        timeoutMs: 50,
        maxRetries: 100,
      });

      const checkStatus = vi.fn().mockResolvedValue('pending' as WorkspaceStatus);

      await expect(poller.pollUntilTerminal(checkStatus)).rejects.toThrow(PollingTimeoutError);

      vi.useFakeTimers(); // Restore for other tests
    });

    it('should apply exponential backoff', async () => {
      const poller = new StatusPoller('ws_test', {
        initialIntervalMs: 100,
        maxIntervalMs: 1000,
        backoffMultiplier: 2,
        maxRetries: 4,
      });

      const checkStatus = vi.fn().mockResolvedValue('pending' as WorkspaceStatus);

      const promise = poller.pollUntilTerminal(checkStatus);

      // First poll (no delay)
      await vi.advanceTimersByTimeAsync(0);
      expect(checkStatus).toHaveBeenCalledTimes(1);

      // Second poll (100ms)
      await vi.advanceTimersByTimeAsync(100);
      expect(checkStatus).toHaveBeenCalledTimes(2);

      // Third poll (200ms = 100 * 2)
      await vi.advanceTimersByTimeAsync(200);
      expect(checkStatus).toHaveBeenCalledTimes(3);

      // Fourth poll (400ms = 200 * 2)
      await vi.advanceTimersByTimeAsync(400);
      expect(checkStatus).toHaveBeenCalledTimes(4);

      await promise;
    });
  });

  describe('streamStatus', () => {
    it('should yield status events on changes', async () => {
      const poller = new StatusPoller('ws_test', {
        initialIntervalMs: 100,
        maxRetries: 10,
      });

      let callCount = 0;
      const statuses: WorkspaceStatus[] = ['pending', 'pending', 'planning', 'merged'];
      const checkStatus = vi.fn().mockImplementation(async () => {
        return statuses[callCount++] ?? 'merged';
      });

      const events: { previous: WorkspaceStatus; current: WorkspaceStatus }[] = [];
      const stream = poller.streamStatus(checkStatus);

      const collectEvents = async () => {
        for await (const event of stream) {
          events.push({
            previous: event.previousStatus,
            current: event.status,
          });
        }
      };

      const collectionPromise = collectEvents();

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }

      await collectionPromise;

      // Should only emit on changes, not on every poll
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({ previous: 'pending', current: 'planning' });
      expect(events[1]).toEqual({ previous: 'planning', current: 'merged' });
    });
  });

  describe('createStatusPoller', () => {
    it('should create a poller with default config', () => {
      const poller = createStatusPoller('ws_test');
      expect(poller).toBeInstanceOf(StatusPoller);
    });

    it('should create a poller with custom config', () => {
      const poller = createStatusPoller('ws_test', {
        initialIntervalMs: 1000,
        maxRetries: 50,
      });
      expect(poller).toBeInstanceOf(StatusPoller);
    });
  });
});

describe('Backoff calculation', () => {
  it('should not exceed maxIntervalMs', async () => {
    vi.useFakeTimers();

    const poller = new StatusPoller('ws_test', {
      initialIntervalMs: 100,
      maxIntervalMs: 300,
      backoffMultiplier: 2,
      maxRetries: 10,
    });

    const delays: number[] = [];
    let lastTime = Date.now();

    const checkStatus = vi.fn().mockImplementation(async () => {
      const now = Date.now();
      if (lastTime !== now) {
        delays.push(now - lastTime);
        lastTime = now;
      }
      return delays.length >= 5 ? 'merged' : 'pending';
    });

    const promise = poller.pollUntilTerminal(checkStatus);

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    await promise;

    // Check that no delay exceeds maxIntervalMs
    for (const delay of delays) {
      expect(delay).toBeLessThanOrEqual(300);
    }

    vi.useRealTimers();
  });
});
