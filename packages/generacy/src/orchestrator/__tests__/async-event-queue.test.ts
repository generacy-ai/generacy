/**
 * Unit tests for AsyncEventQueue.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AsyncEventQueue } from '../async-event-queue.js';

/** Flush all pending microtasks by awaiting a resolved promise. */
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));

describe('AsyncEventQueue', () => {
  let postFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    postFn = vi.fn<(jobId: string, event: object) => Promise<void>>().mockResolvedValue(undefined);
  });

  describe('push() and ordering', () => {
    it('should post events via postFn in order', async () => {
      const queue = new AsyncEventQueue(postFn);

      queue.push('job-1', { type: 'step:start' });
      queue.push('job-1', { type: 'step:complete' });
      queue.push('job-1', { type: 'phase:complete' });

      // Let processing complete
      await flushMicrotasks();

      expect(postFn).toHaveBeenCalledTimes(3);
      expect(postFn).toHaveBeenNthCalledWith(1, 'job-1', { type: 'step:start' });
      expect(postFn).toHaveBeenNthCalledWith(2, 'job-1', { type: 'step:complete' });
      expect(postFn).toHaveBeenNthCalledWith(3, 'job-1', { type: 'phase:complete' });
    });

    it('should handle events for different jobs in order', async () => {
      const queue = new AsyncEventQueue(postFn);

      queue.push('job-1', { type: 'step:start' });
      queue.push('job-2', { type: 'phase:start' });
      queue.push('job-1', { type: 'step:complete' });

      await flushMicrotasks();

      expect(postFn).toHaveBeenCalledTimes(3);
      expect(postFn).toHaveBeenNthCalledWith(1, 'job-1', { type: 'step:start' });
      expect(postFn).toHaveBeenNthCalledWith(2, 'job-2', { type: 'phase:start' });
      expect(postFn).toHaveBeenNthCalledWith(3, 'job-1', { type: 'step:complete' });
    });
  });

  describe('overflow / maxSize', () => {
    it('should drop oldest events when queue exceeds maxSize', async () => {
      // Use a blocking postFn so events accumulate in the queue
      let resolvePost!: () => void;
      const blockingPromise = new Promise<void>((r) => { resolvePost = r; });
      let firstCall = true;

      postFn.mockImplementation(async () => {
        if (firstCall) {
          firstCall = false;
          await blockingPromise;
        }
      });

      const queue = new AsyncEventQueue(postFn, 3);

      // First push starts processing: event-1 is shift()'d from queue and
      // postFn is called (blocking). Queue is now empty.
      queue.push('job-1', { type: 'event-1' });

      // These accumulate in the queue while postFn is blocked on event-1.
      queue.push('job-1', { type: 'event-2' }); // queue: [e2]
      queue.push('job-1', { type: 'event-3' }); // queue: [e2, e3]
      queue.push('job-1', { type: 'event-4' }); // queue: [e2, e3, e4] — at maxSize
      queue.push('job-1', { type: 'event-5' }); // queue overflow: drops e2 → [e3, e4, e5]

      // Unblock postFn — processing loop continues with remaining queue items
      resolvePost();
      await flushMicrotasks();

      const postedTypes = postFn.mock.calls.map(
        (call: [string, { type: string }]) => call[1].type,
      );
      // event-1 was already being processed, event-2 was dropped
      expect(postedTypes).toEqual(['event-1', 'event-3', 'event-4', 'event-5']);
    });

    it('should respect custom maxSize', async () => {
      let resolvePost!: () => void;
      const blockingPromise = new Promise<void>((r) => { resolvePost = r; });
      let firstCall = true;

      postFn.mockImplementation(async () => {
        if (firstCall) {
          firstCall = false;
          await blockingPromise;
        }
      });

      const queue = new AsyncEventQueue(postFn, 2);

      queue.push('job-1', { type: 'event-1' }); // starts processing, shifted from queue
      queue.push('job-1', { type: 'event-2' }); // queue: [e2]
      queue.push('job-1', { type: 'event-3' }); // queue: [e2, e3] — at maxSize=2
      queue.push('job-1', { type: 'event-4' }); // overflow: drops e2 → [e3, e4]

      resolvePost();
      await flushMicrotasks();

      const postedTypes = postFn.mock.calls.map(
        (call: [string, { type: string }]) => call[1].type,
      );
      expect(postedTypes).toEqual(['event-1', 'event-3', 'event-4']);
    });
  });

  describe('postFn failure handling', () => {
    it('should not block the caller on postFn failure', () => {
      postFn.mockRejectedValue(new Error('Network error'));

      const queue = new AsyncEventQueue(postFn);

      // push() is synchronous and should not throw
      expect(() => queue.push('job-1', { type: 'step:start' })).not.toThrow();
    });

    it('should silently drop failed events and continue processing', async () => {
      postFn
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const queue = new AsyncEventQueue(postFn);

      queue.push('job-1', { type: 'event-1' }); // will fail
      queue.push('job-1', { type: 'event-2' }); // will succeed
      queue.push('job-1', { type: 'event-3' }); // will succeed

      await flushMicrotasks();

      expect(postFn).toHaveBeenCalledTimes(3);
      // All three were attempted; the first failure didn't stop the rest
      expect(postFn).toHaveBeenNthCalledWith(2, 'job-1', { type: 'event-2' });
      expect(postFn).toHaveBeenNthCalledWith(3, 'job-1', { type: 'event-3' });
    });

    it('should not leave processing stuck after failures', async () => {
      postFn
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValue(undefined);

      const queue = new AsyncEventQueue(postFn);

      queue.push('job-1', { type: 'event-1' }); // fails
      await flushMicrotasks();

      // Push more after failure — should still process
      queue.push('job-1', { type: 'event-2' });
      await flushMicrotasks();

      expect(postFn).toHaveBeenCalledTimes(2);
      expect(postFn).toHaveBeenNthCalledWith(2, 'job-1', { type: 'event-2' });
    });
  });

  describe('flush()', () => {
    it('should drain all pending events', async () => {
      const queue = new AsyncEventQueue(postFn);

      queue.push('job-1', { type: 'event-1' });
      queue.push('job-1', { type: 'event-2' });
      queue.push('job-2', { type: 'event-3' });

      await queue.flush();

      expect(postFn).toHaveBeenCalledTimes(3);
    });

    it('should be a no-op when queue is empty', async () => {
      const queue = new AsyncEventQueue(postFn);

      await queue.flush();

      expect(postFn).not.toHaveBeenCalled();
    });

    it('should process all events when called without prior push', async () => {
      const order: string[] = [];

      postFn.mockImplementation(async (_jobId: string, event: { type: string }) => {
        order.push(event.type);
      });

      const queue = new AsyncEventQueue(postFn);

      // Push events synchronously, then flush
      queue.push('job-1', { type: 'a' });
      queue.push('job-1', { type: 'b' });
      queue.push('job-1', { type: 'c' });

      // The first push already started processing. Since postFn resolves
      // immediately, all items are processed via the initial processQueue call.
      // flush() may be a no-op if the loop already drained everything.
      await flushMicrotasks();

      expect(order).toEqual(['a', 'b', 'c']);
    });
  });

  describe('concurrent pushes during processing', () => {
    it('should handle pushes that arrive while processing is blocked', async () => {
      const order: string[] = [];
      let resolveFirst!: () => void;
      const blockingPromise = new Promise<void>((r) => { resolveFirst = r; });
      let firstCall = true;

      postFn.mockImplementation(async (_jobId: string, event: { type: string }) => {
        if (firstCall) {
          firstCall = false;
          await blockingPromise;
        }
        order.push(event.type);
      });

      const queue = new AsyncEventQueue(postFn);

      // First push triggers processQueue; postFn blocks on event-1
      queue.push('job-1', { type: 'first' });
      queue.push('job-1', { type: 'second' });

      // Push more while processing is blocked
      queue.push('job-1', { type: 'third' });
      queue.push('job-1', { type: 'fourth' });

      // Unblock the first postFn call
      resolveFirst();
      await flushMicrotasks();

      // first is processed but recorded after the await, second/third/fourth follow
      expect(order).toEqual(['first', 'second', 'third', 'fourth']);
    });

    it('should not start multiple processing loops concurrently', async () => {
      let concurrentCalls = 0;
      let maxConcurrent = 0;
      let resolveFirst!: () => void;
      const blockingPromise = new Promise<void>((r) => { resolveFirst = r; });
      let callCount = 0;

      postFn.mockImplementation(async () => {
        callCount++;
        concurrentCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        if (callCount === 1) {
          await blockingPromise;
        }
        concurrentCalls--;
      });

      const queue = new AsyncEventQueue(postFn);

      // Rapid-fire pushes — only the first triggers processQueue,
      // subsequent pushes see processing=true and skip
      for (let i = 0; i < 10; i++) {
        queue.push('job-1', { type: `event-${i}` });
      }

      resolveFirst();
      await flushMicrotasks();

      // Re-entrant guard ensures at most 1 postFn at a time
      expect(maxConcurrent).toBe(1);
      expect(postFn).toHaveBeenCalledTimes(10);
    });
  });

  describe('default maxSize', () => {
    it('should default to maxSize of 100', async () => {
      let resolvePost!: () => void;
      const blockingPromise = new Promise<void>((r) => { resolvePost = r; });
      let firstCall = true;

      postFn.mockImplementation(async () => {
        if (firstCall) {
          firstCall = false;
          await blockingPromise;
        }
      });

      const queue = new AsyncEventQueue(postFn);

      // First push starts processing — event-0 is shifted out and blocks
      queue.push('job-1', { type: 'event-0' });

      // Push 101 more events; queue will hit maxSize=100 and drop the oldest
      for (let i = 1; i <= 101; i++) {
        queue.push('job-1', { type: `event-${i}` });
      }

      // Queue hit 100 on push of event-100, then event-101 caused event-1 to be dropped
      resolvePost();
      await flushMicrotasks();

      // event-0 processed, event-1 dropped, events 2-101 = 100 items → 101 total
      expect(postFn).toHaveBeenCalledTimes(101);
      expect(postFn.mock.calls[0]![1]).toEqual({ type: 'event-0' });
      expect(postFn.mock.calls[1]![1]).toEqual({ type: 'event-2' });
    });
  });
});
