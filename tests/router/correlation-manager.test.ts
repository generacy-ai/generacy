import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CorrelationManager,
  CorrelationTimeoutError,
  CorrelationCancelledError,
} from '../../src/router/correlation-manager.js';
import type { MessageEnvelope } from '../../src/types/messages.js';

describe('CorrelationManager', () => {
  let manager: CorrelationManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new CorrelationManager();
  });

  afterEach(() => {
    // Suppress unhandled rejections from cancelling pending correlations during cleanup.
    // Tests that need to assert on cancellation behaviour do so explicitly.
    try { manager.cancelAll(); } catch { /* ignore */ }
    vi.useRealTimers();
  });

  const createRequest = (correlationId: string): MessageEnvelope => ({
    id: `msg-${correlationId}`,
    correlationId,
    type: 'decision_request',
    source: { type: 'agency', id: 'agency-1' },
    payload: { question: 'approve?' },
    meta: { timestamp: Date.now() },
  });

  const createResponse = (correlationId: string): MessageEnvelope => ({
    id: `resp-${correlationId}`,
    correlationId,
    type: 'decision_response',
    source: { type: 'humancy', id: 'humancy-1' },
    destination: { type: 'agency', id: 'agency-1' },
    payload: { approved: true },
    meta: { timestamp: Date.now() },
  });

  describe('waitForResponse', () => {
    it('resolves when correlation completes', async () => {
      const request = createRequest('corr-1');
      const response = createResponse('corr-1');

      const promise = manager.waitForResponse(request, 5000);

      // Simulate response arriving
      manager.correlate('corr-1', response);

      await expect(promise).resolves.toBe(response);
    });

    it('rejects on timeout', async () => {
      const request = createRequest('corr-1');
      const promise = manager.waitForResponse(request, 1000);

      // Advance past timeout
      vi.advanceTimersByTime(1001);

      await expect(promise).rejects.toThrow(CorrelationTimeoutError);
    });

    it('throws when request has no correlationId', async () => {
      const request = {
        id: 'msg-1',
        type: 'decision_request' as const,
        source: { type: 'agency' as const, id: 'agency-1' },
        payload: {},
        meta: { timestamp: Date.now() },
      };

      await expect(manager.waitForResponse(request, 5000)).rejects.toThrow(
        'Request must have a correlationId'
      );
    });

    it('throws when correlation is already pending', async () => {
      const request = createRequest('corr-1');
      manager.waitForResponse(request, 5000).catch(() => {});

      await expect(manager.waitForResponse(request, 5000)).rejects.toThrow(
        'Correlation corr-1 is already pending'
      );
    });
  });

  describe('waitForCorrelation', () => {
    it('resolves when correlation completes', async () => {
      const response = createResponse('corr-1');
      const promise = manager.waitForCorrelation('corr-1', 5000);

      manager.correlate('corr-1', response);

      await expect(promise).resolves.toBe(response);
    });

    it('can set request after waitForCorrelation', async () => {
      const request = createRequest('corr-1');
      const response = createResponse('corr-1');

      const promise = manager.waitForCorrelation('corr-1', 5000);
      manager.setRequest('corr-1', request);
      manager.correlate('corr-1', response);

      await expect(promise).resolves.toBe(response);
    });
  });

  describe('correlate', () => {
    it('returns true when correlation exists', async () => {
      const request = createRequest('corr-1');
      const response = createResponse('corr-1');

      manager.waitForResponse(request, 5000).catch(() => {});

      expect(manager.correlate('corr-1', response)).toBe(true);
    });

    it('returns false when correlation does not exist', () => {
      const response = createResponse('corr-1');
      expect(manager.correlate('corr-1', response)).toBe(false);
    });

    it('removes correlation after completion', async () => {
      const request = createRequest('corr-1');
      const response = createResponse('corr-1');

      manager.waitForResponse(request, 5000);
      manager.correlate('corr-1', response);

      expect(manager.isPending('corr-1')).toBe(false);
    });
  });

  describe('cancel', () => {
    it('cancels a pending correlation', async () => {
      const request = createRequest('corr-1');
      const promise = manager.waitForResponse(request, 5000);

      expect(manager.cancel('corr-1')).toBe(true);

      await expect(promise).rejects.toThrow(CorrelationCancelledError);
    });

    it('returns false for non-existent correlation', () => {
      expect(manager.cancel('non-existent')).toBe(false);
    });

    it('removes correlation after cancellation', () => {
      const request = createRequest('corr-1');
      manager.waitForResponse(request, 5000).catch(() => {});
      manager.cancel('corr-1');

      expect(manager.isPending('corr-1')).toBe(false);
    });
  });

  describe('cancelAll', () => {
    it('cancels all pending correlations', async () => {
      const request1 = createRequest('corr-1');
      const request2 = createRequest('corr-2');

      const promise1 = manager.waitForResponse(request1, 5000);
      const promise2 = manager.waitForResponse(request2, 5000);

      manager.cancelAll();

      await expect(promise1).rejects.toThrow(CorrelationCancelledError);
      await expect(promise2).rejects.toThrow(CorrelationCancelledError);
      expect(manager.pendingCount).toBe(0);
    });
  });

  describe('isPending', () => {
    it('returns true for pending correlation', () => {
      const request = createRequest('corr-1');
      manager.waitForResponse(request, 5000).catch(() => {});

      expect(manager.isPending('corr-1')).toBe(true);
    });

    it('returns false for non-existent correlation', () => {
      expect(manager.isPending('non-existent')).toBe(false);
    });
  });

  describe('pendingCount', () => {
    it('returns correct count', () => {
      expect(manager.pendingCount).toBe(0);

      manager.waitForResponse(createRequest('corr-1'), 5000).catch(() => {});
      expect(manager.pendingCount).toBe(1);

      manager.waitForResponse(createRequest('corr-2'), 5000).catch(() => {});
      expect(manager.pendingCount).toBe(2);

      manager.cancel('corr-1');
      expect(manager.pendingCount).toBe(1);
    });
  });

  describe('getPendingInfo', () => {
    it('returns info about pending correlations', () => {
      const request = createRequest('corr-1');
      manager.waitForResponse(request, 5000).catch(() => {});

      const info = manager.getPendingInfo();

      expect(info).toHaveLength(1);
      expect(info[0]?.correlationId).toBe('corr-1');
      expect(info[0]?.requestId).toBe('msg-corr-1');
      expect(info[0]?.remainingMs).toBeLessThanOrEqual(5000);
    });
  });

  describe('events', () => {
    it('emits correlation:started event', () => {
      const request = createRequest('corr-1');
      const startedHandler = vi.fn();
      manager.on('correlation:started', startedHandler);

      manager.waitForResponse(request, 5000).catch(() => {});

      expect(startedHandler).toHaveBeenCalledWith('corr-1', request);
    });

    it('emits correlation:completed event', async () => {
      const request = createRequest('corr-1');
      const response = createResponse('corr-1');
      const completedHandler = vi.fn();
      manager.on('correlation:completed', completedHandler);

      manager.waitForResponse(request, 5000).catch(() => {});
      manager.correlate('corr-1', response);

      expect(completedHandler).toHaveBeenCalledWith('corr-1', request, response);
    });

    it('emits correlation:timeout event', async () => {
      const request = createRequest('corr-1');
      const timeoutHandler = vi.fn();
      manager.on('correlation:timeout', timeoutHandler);

      manager.waitForResponse(request, 1000).catch(() => {});
      vi.advanceTimersByTime(1001);

      expect(timeoutHandler).toHaveBeenCalledWith('corr-1', request);
    });

    it('emits correlation:cancelled event', () => {
      const request = createRequest('corr-1');
      const cancelledHandler = vi.fn();
      manager.on('correlation:cancelled', cancelledHandler);

      manager.waitForResponse(request, 5000).catch(() => {});
      manager.cancel('corr-1');

      expect(cancelledHandler).toHaveBeenCalledWith('corr-1');
    });

    it('removes event listeners with off()', () => {
      const request = createRequest('corr-1');
      const startedHandler = vi.fn();

      manager.on('correlation:started', startedHandler);
      manager.off('correlation:started', startedHandler);
      manager.waitForResponse(request, 5000).catch(() => {});

      expect(startedHandler).not.toHaveBeenCalled();
    });
  });
});
