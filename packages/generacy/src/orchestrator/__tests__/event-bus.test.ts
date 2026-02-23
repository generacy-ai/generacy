/**
 * Unit tests for RingBuffer and EventBus classes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ServerResponse } from 'node:http';
import { RingBuffer, EventBus } from '../event-bus.js';
import { LogBufferManager } from '../log-buffer.js';
import type { JobQueue } from '../job-queue.js';
import type { Job, JobEvent, JobEventType } from '../types.js';

describe('RingBuffer', () => {
  describe('constructor', () => {
    it('should create a buffer with the given capacity', () => {
      const buf = new RingBuffer<number>(5);
      expect(buf.capacity).toBe(5);
      expect(buf.size).toBe(0);
      expect(buf.baseIndex).toBe(0);
    });

    it('should default to capacity 1000', () => {
      const buf = new RingBuffer<number>();
      expect(buf.capacity).toBe(1000);
    });

    it('should throw if capacity is less than 1', () => {
      expect(() => new RingBuffer<number>(0)).toThrow(
        'RingBuffer capacity must be at least 1',
      );
      expect(() => new RingBuffer<number>(-1)).toThrow(
        'RingBuffer capacity must be at least 1',
      );
    });
  });

  describe('push and getAll', () => {
    it('should store items up to capacity and return in insertion order', () => {
      const buf = new RingBuffer<number>(5);
      buf.push(10);
      buf.push(20);
      buf.push(30);

      expect(buf.getAll()).toEqual([10, 20, 30]);
      expect(buf.size).toBe(3);
      expect(buf.baseIndex).toBe(0);
    });

    it('should store exactly capacity items', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);

      expect(buf.getAll()).toEqual([1, 2, 3]);
      expect(buf.size).toBe(3);
      expect(buf.baseIndex).toBe(0);
    });

    it('should evict oldest items when exceeding capacity', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4); // evicts 1

      expect(buf.getAll()).toEqual([2, 3, 4]);
      expect(buf.size).toBe(3);
      expect(buf.baseIndex).toBe(1);
    });

    it('should handle multiple evictions correctly', () => {
      const buf = new RingBuffer<number>(3);
      for (let i = 1; i <= 10; i++) {
        buf.push(i);
      }

      // Buffer holds last 3: [8, 9, 10]
      expect(buf.getAll()).toEqual([8, 9, 10]);
      expect(buf.size).toBe(3);
      expect(buf.baseIndex).toBe(7); // 10 items - 3 capacity = 7 evicted
    });

    it('should work with a buffer of capacity 1', () => {
      const buf = new RingBuffer<string>(1);
      buf.push('a');
      expect(buf.getAll()).toEqual(['a']);
      expect(buf.baseIndex).toBe(0);

      buf.push('b');
      expect(buf.getAll()).toEqual(['b']);
      expect(buf.baseIndex).toBe(1);

      buf.push('c');
      expect(buf.getAll()).toEqual(['c']);
      expect(buf.baseIndex).toBe(2);
    });

    it('should work with non-primitive types', () => {
      const buf = new RingBuffer<{ id: number; name: string }>(2);
      buf.push({ id: 1, name: 'first' });
      buf.push({ id: 2, name: 'second' });

      expect(buf.getAll()).toEqual([
        { id: 1, name: 'first' },
        { id: 2, name: 'second' },
      ]);
    });
  });

  describe('getAfterIndex', () => {
    it('should return items after a given buffer-relative index', () => {
      const buf = new RingBuffer<string>(5);
      buf.push('a'); // logical index 0
      buf.push('b'); // logical index 1
      buf.push('c'); // logical index 2
      buf.push('d'); // logical index 3

      // Items after index 1 → logical indices 2, 3 → ['c', 'd']
      expect(buf.getAfterIndex(1)).toEqual(['c', 'd']);
    });

    it('should return empty array when index is at or beyond the last item', () => {
      const buf = new RingBuffer<number>(5);
      buf.push(10);
      buf.push(20);
      buf.push(30);

      // Last item is at logical index 2
      expect(buf.getAfterIndex(2)).toEqual([]);
      expect(buf.getAfterIndex(3)).toEqual([]);
      expect(buf.getAfterIndex(100)).toEqual([]);
    });

    it('should return all items when index is before buffer start', () => {
      const buf = new RingBuffer<number>(3);
      for (let i = 1; i <= 5; i++) {
        buf.push(i);
      }
      // Buffer: [3, 4, 5], baseIndex = 2

      // Index 0 is before the buffer start (baseIndex=2) → returns all
      expect(buf.getAfterIndex(0)).toEqual([3, 4, 5]);
      // Index 1 is also before buffer start
      expect(buf.getAfterIndex(1)).toEqual([3, 4, 5]);
    });

    it('should return all items when index is negative', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);

      expect(buf.getAfterIndex(-1)).toEqual([1, 2]);
      expect(buf.getAfterIndex(-100)).toEqual([1, 2]);
    });

    it('should return items correctly after eviction has occurred', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4);
      buf.push(5);
      // Buffer: [3, 4, 5], baseIndex = 2

      // After index 2 (the first buffered item) → [4, 5]
      expect(buf.getAfterIndex(2)).toEqual([4, 5]);
      // After index 3 → [5]
      expect(buf.getAfterIndex(3)).toEqual([5]);
      // After index 4 (the last item) → []
      expect(buf.getAfterIndex(4)).toEqual([]);
    });

    it('should return empty array on empty buffer', () => {
      const buf = new RingBuffer<number>(5);
      expect(buf.getAfterIndex(0)).toEqual([]);
      expect(buf.getAfterIndex(-1)).toEqual([]);
    });

    it('should return all items when startIndex equals baseIndex - 1', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(10);
      buf.push(20);
      buf.push(30);
      // baseIndex = 0, items at logical indices 0, 1, 2

      // getAfterIndex(-1) → skip = -1 - 0 + 1 = 0 → returns all
      expect(buf.getAfterIndex(-1)).toEqual([10, 20, 30]);
    });

    it('should work with wrap-around reads', () => {
      const buf = new RingBuffer<number>(4);
      // Fill then overflow to force head to wrap
      buf.push(1);
      buf.push(2);
      buf.push(3);
      buf.push(4);
      buf.push(5); // evicts 1, head moves
      buf.push(6); // evicts 2, head moves
      // Buffer: [3, 4, 5, 6], baseIndex = 2

      expect(buf.getAfterIndex(3)).toEqual([5, 6]);
      expect(buf.getAfterIndex(2)).toEqual([4, 5, 6]);
    });
  });

  describe('clear', () => {
    it('should empty the buffer and reset state', () => {
      const buf = new RingBuffer<number>(5);
      buf.push(1);
      buf.push(2);
      buf.push(3);

      buf.clear();

      expect(buf.size).toBe(0);
      expect(buf.baseIndex).toBe(0);
      expect(buf.getAll()).toEqual([]);
    });

    it('should reset after evictions have occurred', () => {
      const buf = new RingBuffer<number>(2);
      buf.push(1);
      buf.push(2);
      buf.push(3); // evicts 1
      expect(buf.baseIndex).toBe(1);

      buf.clear();

      expect(buf.size).toBe(0);
      expect(buf.baseIndex).toBe(0);
      expect(buf.getAll()).toEqual([]);
    });

    it('should allow reuse after clearing', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.clear();

      buf.push(10);
      buf.push(20);

      expect(buf.getAll()).toEqual([10, 20]);
      expect(buf.size).toBe(2);
      expect(buf.baseIndex).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('should return empty array from getAll on empty buffer', () => {
      const buf = new RingBuffer<number>(10);
      expect(buf.getAll()).toEqual([]);
    });

    it('should handle a single item correctly', () => {
      const buf = new RingBuffer<number>(5);
      buf.push(42);

      expect(buf.size).toBe(1);
      expect(buf.getAll()).toEqual([42]);
      expect(buf.getAfterIndex(-1)).toEqual([42]);
      expect(buf.getAfterIndex(0)).toEqual([]);
    });

    it('should handle exactly-at-capacity boundary', () => {
      const buf = new RingBuffer<number>(3);
      buf.push(1);
      buf.push(2);
      buf.push(3);

      expect(buf.size).toBe(3);
      expect(buf.capacity).toBe(3);
      expect(buf.baseIndex).toBe(0);
      expect(buf.getAll()).toEqual([1, 2, 3]);

      // One more push tips it over
      buf.push(4);
      expect(buf.size).toBe(3);
      expect(buf.baseIndex).toBe(1);
      expect(buf.getAll()).toEqual([2, 3, 4]);
    });

    it('should maintain correct getAll order through many wrap-arounds', () => {
      const buf = new RingBuffer<number>(3);
      for (let i = 0; i < 100; i++) {
        buf.push(i);
      }

      expect(buf.getAll()).toEqual([97, 98, 99]);
      expect(buf.size).toBe(3);
      expect(buf.baseIndex).toBe(97);
    });

    it('should handle getAfterIndex at exact baseIndex boundary', () => {
      const buf = new RingBuffer<number>(3);
      for (let i = 1; i <= 6; i++) {
        buf.push(i);
      }
      // Buffer: [4, 5, 6], baseIndex = 3

      // getAfterIndex(baseIndex - 1) = getAfterIndex(2) → returns all
      expect(buf.getAfterIndex(2)).toEqual([4, 5, 6]);

      // getAfterIndex(baseIndex) = getAfterIndex(3) → skip first, return [5, 6]
      expect(buf.getAfterIndex(3)).toEqual([5, 6]);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers for EventBus tests
// ---------------------------------------------------------------------------

/** Create a mock ServerResponse with write(), on(), and end() stubs. */
function createMockResponse(): ServerResponse & {
  writtenData: string[];
  closeHandlers: Array<() => void>;
  ended: boolean;
} {
  const closeHandlers: Array<() => void> = [];
  const writtenData: string[] = [];
  let ended = false;

  const res = {
    writtenData,
    closeHandlers,
    ended,
    write: vi.fn((data: string) => {
      writtenData.push(data);
      return true;
    }),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'close') {
        closeHandlers.push(handler);
      }
    }),
    end: vi.fn(() => {
      ended = true;
      res.ended = true;
    }),
  };

  return res as unknown as ServerResponse & {
    writtenData: string[];
    closeHandlers: Array<() => void>;
    ended: boolean;
  };
}

/** Create a mock JobQueue with a configurable getJob response. */
function createMockJobQueue(jobs: Map<string, Job> = new Map()): JobQueue {
  return {
    enqueue: vi.fn(),
    poll: vi.fn(),
    updateStatus: vi.fn(),
    reportResult: vi.fn(),
    getJob: vi.fn(async (jobId: string) => jobs.get(jobId) ?? null),
    cancelJob: vi.fn(),
  };
}

/** Create a minimal Job object for testing. */
function createJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    name: 'test-job',
    status: 'running',
    priority: 'normal',
    workflow: 'default',
    inputs: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a minimal event payload (without the `id` field which publish() assigns). */
function createEventPayload(
  overrides: Partial<Omit<JobEvent, 'id'>> = {},
): Omit<JobEvent, 'id'> {
  return {
    type: 'step:start',
    timestamp: Date.now(),
    jobId: 'job-1',
    data: { step: 'build' },
    ...overrides,
  };
}

/** Parse the SSE data field from a written frame string. */
function parseSSEFrame(frame: string): {
  event?: string;
  id?: string;
  data?: JobEvent;
} {
  const result: { event?: string; id?: string; data?: JobEvent } = {};
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) result.event = line.slice(7);
    else if (line.startsWith('id: ')) result.id = line.slice(4);
    else if (line.startsWith('data: ')) result.data = JSON.parse(line.slice(6));
  }
  return result;
}

// ---------------------------------------------------------------------------
// EventBus — publish and subscribe tests (T019)
// ---------------------------------------------------------------------------

describe('EventBus', () => {
  let jobQueue: JobQueue;
  let eventBus: EventBus;

  beforeEach(() => {
    jobQueue = createMockJobQueue();
    eventBus = new EventBus({ jobQueue, bufferSize: 100, heartbeatInterval: 60_000 });
  });

  afterEach(() => {
    eventBus.destroy();
  });

  describe('publish()', () => {
    it('should assign monotonically increasing string IDs per job', async () => {
      const e1 = await eventBus.publish('job-1', createEventPayload());
      const e2 = await eventBus.publish('job-1', createEventPayload());
      const e3 = await eventBus.publish('job-1', createEventPayload());

      expect(e1.id).toBe('1');
      expect(e2.id).toBe('2');
      expect(e3.id).toBe('3');
    });

    it('should maintain independent counters per job', async () => {
      const a1 = await eventBus.publish('job-a', createEventPayload({ jobId: 'job-a' }));
      const b1 = await eventBus.publish('job-b', createEventPayload({ jobId: 'job-b' }));
      const a2 = await eventBus.publish('job-a', createEventPayload({ jobId: 'job-a' }));

      expect(a1.id).toBe('1');
      expect(b1.id).toBe('1');
      expect(a2.id).toBe('2');
    });

    it('should buffer events in the correct job ring buffer', async () => {
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'phase:start' }));
      await eventBus.publish('job-2', createEventPayload({ jobId: 'job-2', type: 'step:start' }));
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'phase:complete' }));

      const job1Events = eventBus.getBufferedEvents('job-1');
      const job2Events = eventBus.getBufferedEvents('job-2');

      expect(job1Events).toHaveLength(2);
      expect(job1Events[0]!.type).toBe('phase:start');
      expect(job1Events[1]!.type).toBe('phase:complete');

      expect(job2Events).toHaveLength(1);
      expect(job2Events[0]!.type).toBe('step:start');
    });

    it('should return the full event with assigned id', async () => {
      const payload = createEventPayload({ type: 'job:status', data: { status: 'running' } });
      const event = await eventBus.publish('job-1', payload);

      expect(event.id).toBe('1');
      expect(event.type).toBe('job:status');
      expect(event.jobId).toBe('job-1');
      expect(event.data).toEqual({ status: 'running' });
      expect(event.timestamp).toBe(payload.timestamp);
    });

    it('should broadcast to per-job subscribers via res.write()', async () => {
      const res = createMockResponse();
      eventBus.subscribe('job-1', res);

      await eventBus.publish('job-1', createEventPayload({ type: 'step:start' }));

      expect(res.write).toHaveBeenCalledTimes(1);
      const frame = parseSSEFrame(res.writtenData[0]!);
      expect(frame.event).toBe('step:start');
      expect(frame.id).toBe('1');
      expect(frame.data?.type).toBe('step:start');
    });

    it('should broadcast to multiple subscribers on the same job', async () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      eventBus.subscribe('job-1', res1);
      eventBus.subscribe('job-1', res2);

      await eventBus.publish('job-1', createEventPayload());

      expect(res1.write).toHaveBeenCalledTimes(1);
      expect(res2.write).toHaveBeenCalledTimes(1);
      // Both should receive the same frame
      expect(res1.writtenData[0]).toBe(res2.writtenData[0]);
    });

    it('should not broadcast to subscribers of a different job', async () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      eventBus.subscribe('job-1', res1);
      eventBus.subscribe('job-2', res2);

      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1' }));

      expect(res1.write).toHaveBeenCalledTimes(1);
      expect(res2.write).not.toHaveBeenCalled();
    });

    it('should handle write errors by cleaning up dead subscriber', async () => {
      const goodRes = createMockResponse();
      const deadRes = createMockResponse();
      (deadRes.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Connection reset');
      });

      eventBus.subscribe('job-1', goodRes);
      eventBus.subscribe('job-1', deadRes);

      // First publish: deadRes throws, should be removed
      await eventBus.publish('job-1', createEventPayload());

      // Second publish: only goodRes should receive
      await eventBus.publish('job-1', createEventPayload());

      expect(goodRes.write).toHaveBeenCalledTimes(2);
      expect(deadRes.write).toHaveBeenCalledTimes(1); // Only the first (throwing) call
    });

    it('should return empty array for getBufferedEvents on unknown job', () => {
      expect(eventBus.getBufferedEvents('nonexistent')).toEqual([]);
    });
  });

  describe('subscribe()', () => {
    it('should receive no events until something is published', () => {
      const res = createMockResponse();
      eventBus.subscribe('job-1', res);

      expect(res.write).not.toHaveBeenCalled();
    });

    it('should register a close handler for auto-unsubscribe', () => {
      const res = createMockResponse();
      eventBus.subscribe('job-1', res);

      expect(res.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should auto-unsubscribe when connection closes', async () => {
      const res = createMockResponse();
      eventBus.subscribe('job-1', res);

      // Simulate connection close
      res.closeHandlers.forEach((handler) => handler());

      // Now publish — should not receive the event
      await eventBus.publish('job-1', createEventPayload());
      expect(res.write).not.toHaveBeenCalled();
    });

    it('should replay buffered events when lastEventId is not provided (no replay)', async () => {
      // Publish events before subscribing
      await eventBus.publish('job-1', createEventPayload({ type: 'phase:start' }));
      await eventBus.publish('job-1', createEventPayload({ type: 'phase:complete' }));

      const res = createMockResponse();
      // No lastEventId → no replay
      eventBus.subscribe('job-1', res);

      expect(res.write).not.toHaveBeenCalled();
    });

    it('should replay buffered events after lastEventId', async () => {
      await eventBus.publish('job-1', createEventPayload({ type: 'phase:start' }));
      await eventBus.publish('job-1', createEventPayload({ type: 'step:start' }));
      await eventBus.publish('job-1', createEventPayload({ type: 'step:complete' }));

      const res = createMockResponse();
      // Subscribe with lastEventId "1" → should replay events 2 and 3
      eventBus.subscribe('job-1', res, '1');

      expect(res.write).toHaveBeenCalledTimes(2);
      const frame1 = parseSSEFrame(res.writtenData[0]!);
      const frame2 = parseSSEFrame(res.writtenData[1]!);
      expect(frame1.id).toBe('2');
      expect(frame1.event).toBe('step:start');
      expect(frame2.id).toBe('3');
      expect(frame2.event).toBe('step:complete');
    });

    it('should replay all buffered events when lastEventId is unknown/expired', async () => {
      await eventBus.publish('job-1', createEventPayload({ type: 'phase:start' }));
      await eventBus.publish('job-1', createEventPayload({ type: 'step:start' }));

      const res = createMockResponse();
      // Subscribe with a non-numeric lastEventId → replays all
      eventBus.subscribe('job-1', res, 'garbage');

      expect(res.write).toHaveBeenCalledTimes(2);
      const frame1 = parseSSEFrame(res.writtenData[0]!);
      expect(frame1.id).toBe('1');
    });

    it('should replay all events when lastEventId is "0"', async () => {
      await eventBus.publish('job-1', createEventPayload({ type: 'phase:start' }));
      await eventBus.publish('job-1', createEventPayload({ type: 'step:start' }));

      const res = createMockResponse();
      // lastEventId "0" → getAfterIndex(-1) → returns all
      eventBus.subscribe('job-1', res, '0');

      expect(res.write).toHaveBeenCalledTimes(2);
    });

    it('should replay no events when lastEventId matches the latest event', async () => {
      await eventBus.publish('job-1', createEventPayload());
      await eventBus.publish('job-1', createEventPayload());

      const res = createMockResponse();
      // lastEventId "2" is the latest → nothing after it
      eventBus.subscribe('job-1', res, '2');

      expect(res.write).not.toHaveBeenCalled();
    });

    it('should receive live events after replay', async () => {
      await eventBus.publish('job-1', createEventPayload({ type: 'phase:start' }));

      const res = createMockResponse();
      eventBus.subscribe('job-1', res, '0');

      // Replayed: 1 event
      expect(res.write).toHaveBeenCalledTimes(1);

      // Now publish a new live event
      await eventBus.publish('job-1', createEventPayload({ type: 'step:start' }));

      // Replayed + live = 2 total
      expect(res.write).toHaveBeenCalledTimes(2);
      const liveFrame = parseSSEFrame(res.writtenData[1]!);
      expect(liveFrame.id).toBe('2');
      expect(liveFrame.event).toBe('step:start');
    });

    it('should handle replay on empty buffer gracefully', () => {
      const res = createMockResponse();
      eventBus.subscribe('job-1', res, '5');

      // No events to replay, no crash
      expect(res.write).not.toHaveBeenCalled();
    });

    it('should handle replay write error by unsubscribing', async () => {
      await eventBus.publish('job-1', createEventPayload());
      await eventBus.publish('job-1', createEventPayload());

      const res = createMockResponse();
      (res.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Connection reset');
      });

      eventBus.subscribe('job-1', res, '0');

      // Write failed during replay — subscriber should be removed
      // Publish another event — should not crash or try to write
      await eventBus.publish('job-1', createEventPayload());
      // write was called once (the first replay attempt that threw)
      expect(res.write).toHaveBeenCalledTimes(1);
    });
  });

  describe('unsubscribe()', () => {
    it('should remove subscriber so no further events are received', async () => {
      const res = createMockResponse();
      eventBus.subscribe('job-1', res);

      await eventBus.publish('job-1', createEventPayload());
      expect(res.write).toHaveBeenCalledTimes(1);

      eventBus.unsubscribe(res);

      await eventBus.publish('job-1', createEventPayload());
      // Still only 1 call — no new events after unsubscribe
      expect(res.write).toHaveBeenCalledTimes(1);
    });

    it('should handle unsubscribing a response not in any set', () => {
      const res = createMockResponse();
      // Should not throw
      expect(() => eventBus.unsubscribe(res)).not.toThrow();
    });

    it('should only remove the specified subscriber, not others', async () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      eventBus.subscribe('job-1', res1);
      eventBus.subscribe('job-1', res2);

      eventBus.unsubscribe(res1);

      await eventBus.publish('job-1', createEventPayload());

      expect(res1.write).not.toHaveBeenCalled();
      expect(res2.write).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------------
  // T020: Replay and Last-Event-ID unit tests
  // ---------------------------------------------------------------------------

  describe('replay and Last-Event-ID (per-job subscribe)', () => {
    it('should replay events in order after the given lastEventId', async () => {
      await eventBus.publish('job-1', createEventPayload({ type: 'phase:start' }));   // id=1
      await eventBus.publish('job-1', createEventPayload({ type: 'step:start' }));    // id=2
      await eventBus.publish('job-1', createEventPayload({ type: 'step:complete' })); // id=3
      await eventBus.publish('job-1', createEventPayload({ type: 'phase:complete' }));// id=4

      const res = createMockResponse();
      eventBus.subscribe('job-1', res, '2');

      // Should receive events 3 and 4 (after id "2")
      expect(res.write).toHaveBeenCalledTimes(2);
      const frame1 = parseSSEFrame(res.writtenData[0]!);
      const frame2 = parseSSEFrame(res.writtenData[1]!);
      expect(frame1.id).toBe('3');
      expect(frame1.event).toBe('step:complete');
      expect(frame2.id).toBe('4');
      expect(frame2.event).toBe('phase:complete');
    });

    it('should replay all buffered events when lastEventId is unknown (non-numeric)', async () => {
      await eventBus.publish('job-1', createEventPayload({ type: 'phase:start' }));
      await eventBus.publish('job-1', createEventPayload({ type: 'step:start' }));

      const res = createMockResponse();
      eventBus.subscribe('job-1', res, 'not-a-number');

      expect(res.write).toHaveBeenCalledTimes(2);
      const frame1 = parseSSEFrame(res.writtenData[0]!);
      expect(frame1.id).toBe('1');
    });

    it('should replay all buffered events when lastEventId has been evicted', async () => {
      // Use a small buffer so events get evicted
      const smallBus = new EventBus({ jobQueue, bufferSize: 3, heartbeatInterval: 60_000 });
      try {
        await smallBus.publish('job-1', createEventPayload({ type: 'phase:start' }));   // id=1
        await smallBus.publish('job-1', createEventPayload({ type: 'step:start' }));    // id=2
        await smallBus.publish('job-1', createEventPayload({ type: 'step:complete' })); // id=3
        await smallBus.publish('job-1', createEventPayload({ type: 'phase:complete' }));// id=4 (evicts 1)
        await smallBus.publish('job-1', createEventPayload({ type: 'step:output' }));   // id=5 (evicts 2)

        const res = createMockResponse();
        // lastEventId "1" has been evicted → replay all buffered events
        smallBus.subscribe('job-1', res, '1');

        // Buffer holds [3, 4, 5] — all should be replayed
        expect(res.write).toHaveBeenCalledTimes(3);
        const frame1 = parseSSEFrame(res.writtenData[0]!);
        const frame3 = parseSSEFrame(res.writtenData[2]!);
        expect(frame1.id).toBe('3');
        expect(frame3.id).toBe('5');
      } finally {
        smallBus.destroy();
      }
    });

    it('should send replayed events before live events', async () => {
      await eventBus.publish('job-1', createEventPayload({ type: 'phase:start' }));  // id=1
      await eventBus.publish('job-1', createEventPayload({ type: 'step:start' }));   // id=2

      const res = createMockResponse();
      // Replay from beginning (lastEventId "0" → all events)
      eventBus.subscribe('job-1', res, '0');

      // Verify replayed events arrived
      expect(res.write).toHaveBeenCalledTimes(2);
      expect(parseSSEFrame(res.writtenData[0]!).id).toBe('1');
      expect(parseSSEFrame(res.writtenData[1]!).id).toBe('2');

      // Now publish a live event
      await eventBus.publish('job-1', createEventPayload({ type: 'step:complete' })); // id=3

      // Live event should come after replayed events
      expect(res.write).toHaveBeenCalledTimes(3);
      expect(parseSSEFrame(res.writtenData[2]!).id).toBe('3');
      expect(parseSSEFrame(res.writtenData[2]!).event).toBe('step:complete');
    });

    it('should replay nothing when lastEventId matches the last buffered event', async () => {
      await eventBus.publish('job-1', createEventPayload());
      await eventBus.publish('job-1', createEventPayload());
      await eventBus.publish('job-1', createEventPayload()); // id=3

      const res = createMockResponse();
      eventBus.subscribe('job-1', res, '3');

      expect(res.write).not.toHaveBeenCalled();
    });

    it('should replay nothing when lastEventId is beyond buffered events', async () => {
      await eventBus.publish('job-1', createEventPayload());

      const res = createMockResponse();
      eventBus.subscribe('job-1', res, '999');

      expect(res.write).not.toHaveBeenCalled();
    });
  });

  describe('replay and Last-Event-ID (global subscribeAll)', () => {
    it('should replay events from specified job after the counter in {jobId}:{counter} format', async () => {
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'phase:start' }));   // id=1
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'step:start' }));    // id=2
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'step:complete' })); // id=3

      const res = createMockResponse();
      // lastEventId "job-1:1" → replay events 2 and 3 from job-1
      await eventBus.subscribeAll(res, {}, 'job-1:1');

      // Events 2 and 3 from job-1 should be replayed
      const replayFrames = res.writtenData.map(parseSSEFrame);
      const job1Frames = replayFrames.filter((f) => f.data?.jobId === 'job-1');
      expect(job1Frames.length).toBe(2);
      expect(job1Frames[0]!.id).toBe('2');
      expect(job1Frames[1]!.id).toBe('3');
    });

    it('should also replay all buffered events from other jobs during global reconnection', async () => {
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'phase:start' }));   // id=1
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'step:start' }));    // id=2
      await eventBus.publish('job-2', createEventPayload({ jobId: 'job-2', type: 'phase:start' }));   // id=1
      await eventBus.publish('job-2', createEventPayload({ jobId: 'job-2', type: 'step:start' }));    // id=2

      const res = createMockResponse();
      // Reconnect with lastEventId "job-1:1" → replay job-1 after 1, plus all of job-2
      await eventBus.subscribeAll(res, {}, 'job-1:1');

      const replayFrames = res.writtenData.map(parseSSEFrame);
      const job1Frames = replayFrames.filter((f) => f.data?.jobId === 'job-1');
      const job2Frames = replayFrames.filter((f) => f.data?.jobId === 'job-2');

      // job-1: event after id 1 → event id=2
      expect(job1Frames.length).toBe(1);
      expect(job1Frames[0]!.id).toBe('2');

      // job-2: all buffered events → id=1, id=2
      expect(job2Frames.length).toBe(2);
      expect(job2Frames[0]!.id).toBe('1');
      expect(job2Frames[1]!.id).toBe('2');
    });

    it('should apply filters during global replay', async () => {
      const job1 = createJob({ id: 'job-1', tags: ['deploy'], workflow: 'deploy-flow' });
      const job2 = createJob({ id: 'job-2', tags: ['build'], workflow: 'build-flow' });
      const filteredQueue = createMockJobQueue(
        new Map([
          ['job-1', job1],
          ['job-2', job2],
        ]),
      );
      const filteredBus = new EventBus({ jobQueue: filteredQueue, bufferSize: 100, heartbeatInterval: 60_000 });

      try {
        await filteredBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'phase:start' }));
        await filteredBus.publish('job-2', createEventPayload({ jobId: 'job-2', type: 'phase:start' }));

        const res = createMockResponse();
        // Subscribe with tag filter for "deploy" only, reconnecting after nothing
        await filteredBus.subscribeAll(res, { tags: ['deploy'] }, 'job-1:0');

        const replayFrames = res.writtenData.map(parseSSEFrame);
        // Only job-1 events should be replayed (matches "deploy" tag)
        expect(replayFrames.every((f) => f.data?.jobId === 'job-1')).toBe(true);
        // job-2 should be filtered out
        expect(replayFrames.some((f) => f.data?.jobId === 'job-2')).toBe(false);
      } finally {
        filteredBus.destroy();
      }
    });

    it('should receive live events after global replay', async () => {
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'phase:start' }));

      const res = createMockResponse();
      await eventBus.subscribeAll(res, {}, 'job-1:0');

      // Replayed: 1 event from job-1
      expect(res.write).toHaveBeenCalledTimes(1);
      expect(parseSSEFrame(res.writtenData[0]!).id).toBe('1');

      // Now publish a live event
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'step:start' }));

      // Replayed + live = 2 total
      expect(res.write).toHaveBeenCalledTimes(2);
      expect(parseSSEFrame(res.writtenData[1]!).id).toBe('2');
    });

    it('should handle global lastEventId with invalid format gracefully (no colon)', async () => {
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'phase:start' }));

      const res = createMockResponse();
      // No colon in lastEventId → cannot parse, no replay
      await eventBus.subscribeAll(res, {}, 'invalid-no-colon');

      // No events replayed because format is invalid
      expect(res.write).not.toHaveBeenCalled();

      // But should still receive live events
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'step:start' }));
      expect(res.write).toHaveBeenCalledTimes(1);
    });

    it('should handle global lastEventId with non-numeric counter gracefully', async () => {
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'phase:start' }));

      const res = createMockResponse();
      // Has colon but non-numeric counter → no replay
      await eventBus.subscribeAll(res, {}, 'job-1:abc');

      expect(res.write).not.toHaveBeenCalled();

      // Still receives live events
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'step:start' }));
      expect(res.write).toHaveBeenCalledTimes(1);
    });

    it('should replay all events from specified job when counter is 0', async () => {
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'phase:start' }));
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'step:start' }));

      const res = createMockResponse();
      await eventBus.subscribeAll(res, {}, 'job-1:0');

      const replayFrames = res.writtenData.map(parseSSEFrame);
      expect(replayFrames.length).toBe(2);
      expect(replayFrames[0]!.id).toBe('1');
      expect(replayFrames[1]!.id).toBe('2');
    });
  });

  // ---------------------------------------------------------------------------
  // T021: Filter, cleanup, and heartbeat unit tests
  // ---------------------------------------------------------------------------

  describe('global subscriber filters', () => {
    it('should deliver events to global subscriber with matching tags filter', async () => {
      const job1 = createJob({ id: 'job-1', tags: ['deploy', 'prod'] });
      const job2 = createJob({ id: 'job-2', tags: ['build', 'ci'] });
      const filteredQueue = createMockJobQueue(
        new Map([
          ['job-1', job1],
          ['job-2', job2],
        ]),
      );
      const bus = new EventBus({ jobQueue: filteredQueue, bufferSize: 100, heartbeatInterval: 60_000 });

      try {
        const res = createMockResponse();
        await bus.subscribeAll(res, { tags: ['deploy'] });

        await bus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'phase:start' }));
        await bus.publish('job-2', createEventPayload({ jobId: 'job-2', type: 'phase:start' }));

        // Only the job-1 event should be delivered (matches 'deploy' tag)
        expect(res.write).toHaveBeenCalledTimes(1);
        const frame = parseSSEFrame(res.writtenData[0]!);
        expect(frame.data?.jobId).toBe('job-1');
      } finally {
        bus.destroy();
      }
    });

    it('should deliver events to global subscriber with matching workflow filter', async () => {
      const job1 = createJob({ id: 'job-1', workflow: 'deploy-flow' });
      const job2 = createJob({ id: 'job-2', workflow: 'build-flow' });
      const filteredQueue = createMockJobQueue(
        new Map([
          ['job-1', job1],
          ['job-2', job2],
        ]),
      );
      const bus = new EventBus({ jobQueue: filteredQueue, bufferSize: 100, heartbeatInterval: 60_000 });

      try {
        const res = createMockResponse();
        await bus.subscribeAll(res, { workflow: 'build-flow' });

        await bus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'step:start' }));
        await bus.publish('job-2', createEventPayload({ jobId: 'job-2', type: 'step:start' }));

        // Only job-2 matches workflow 'build-flow'
        expect(res.write).toHaveBeenCalledTimes(1);
        const frame = parseSSEFrame(res.writtenData[0]!);
        expect(frame.data?.jobId).toBe('job-2');
      } finally {
        bus.destroy();
      }
    });

    it('should deliver events to global subscriber with matching status filter', async () => {
      const job1 = createJob({ id: 'job-1', status: 'running' });
      const job2 = createJob({ id: 'job-2', status: 'pending' });
      const filteredQueue = createMockJobQueue(
        new Map([
          ['job-1', job1],
          ['job-2', job2],
        ]),
      );
      const bus = new EventBus({ jobQueue: filteredQueue, bufferSize: 100, heartbeatInterval: 60_000 });

      try {
        const res = createMockResponse();
        await bus.subscribeAll(res, { status: ['running'] });

        await bus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'step:output' }));
        await bus.publish('job-2', createEventPayload({ jobId: 'job-2', type: 'step:output' }));

        // Only job-1 matches status 'running'
        expect(res.write).toHaveBeenCalledTimes(1);
        const frame = parseSSEFrame(res.writtenData[0]!);
        expect(frame.data?.jobId).toBe('job-1');
      } finally {
        bus.destroy();
      }
    });

    it('should combine multiple filters with AND logic', async () => {
      const job1 = createJob({ id: 'job-1', tags: ['deploy'], workflow: 'deploy-flow', status: 'running' });
      const job2 = createJob({ id: 'job-2', tags: ['deploy'], workflow: 'build-flow', status: 'running' });
      const job3 = createJob({ id: 'job-3', tags: ['test'], workflow: 'deploy-flow', status: 'running' });
      const filteredQueue = createMockJobQueue(
        new Map([
          ['job-1', job1],
          ['job-2', job2],
          ['job-3', job3],
        ]),
      );
      const bus = new EventBus({ jobQueue: filteredQueue, bufferSize: 100, heartbeatInterval: 60_000 });

      try {
        const res = createMockResponse();
        // Must match both tags=['deploy'] AND workflow='deploy-flow'
        await bus.subscribeAll(res, { tags: ['deploy'], workflow: 'deploy-flow' });

        await bus.publish('job-1', createEventPayload({ jobId: 'job-1', type: 'phase:start' }));
        await bus.publish('job-2', createEventPayload({ jobId: 'job-2', type: 'phase:start' }));
        await bus.publish('job-3', createEventPayload({ jobId: 'job-3', type: 'phase:start' }));

        // Only job-1 matches both filters (deploy tag + deploy-flow workflow)
        expect(res.write).toHaveBeenCalledTimes(1);
        const frame = parseSSEFrame(res.writtenData[0]!);
        expect(frame.data?.jobId).toBe('job-1');
      } finally {
        bus.destroy();
      }
    });

    it('should deliver all events when global subscriber has no filters', async () => {
      const res = createMockResponse();
      await eventBus.subscribeAll(res, {});

      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1' }));
      await eventBus.publish('job-2', createEventPayload({ jobId: 'job-2' }));

      expect(res.write).toHaveBeenCalledTimes(2);
    });

    it('should not deliver events when job is not found and filters are set', async () => {
      // Default mock queue returns null for unknown jobs
      const res = createMockResponse();
      await eventBus.subscribeAll(res, { tags: ['deploy'] });

      await eventBus.publish('unknown-job', createEventPayload({ jobId: 'unknown-job' }));

      // Job not found + filters active → no match
      expect(res.write).not.toHaveBeenCalled();
    });

    it('should match status filter with multiple allowed statuses', async () => {
      const job1 = createJob({ id: 'job-1', status: 'completed' });
      const job2 = createJob({ id: 'job-2', status: 'failed' });
      const job3 = createJob({ id: 'job-3', status: 'running' });
      const filteredQueue = createMockJobQueue(
        new Map([
          ['job-1', job1],
          ['job-2', job2],
          ['job-3', job3],
        ]),
      );
      const bus = new EventBus({ jobQueue: filteredQueue, bufferSize: 100, heartbeatInterval: 60_000 });

      try {
        const res = createMockResponse();
        await bus.subscribeAll(res, { status: ['completed', 'failed'] });

        await bus.publish('job-1', createEventPayload({ jobId: 'job-1' }));
        await bus.publish('job-2', createEventPayload({ jobId: 'job-2' }));
        await bus.publish('job-3', createEventPayload({ jobId: 'job-3' }));

        // job-1 (completed) and job-2 (failed) match, job-3 (running) doesn't
        expect(res.write).toHaveBeenCalledTimes(2);
        const frames = res.writtenData.map(parseSSEFrame);
        expect(frames[0]!.data?.jobId).toBe('job-1');
        expect(frames[1]!.data?.jobId).toBe('job-2');
      } finally {
        bus.destroy();
      }
    });

    it('should match tags filter when job has any overlapping tag', async () => {
      const job1 = createJob({ id: 'job-1', tags: ['deploy', 'staging'] });
      const filteredQueue = createMockJobQueue(new Map([['job-1', job1]]));
      const bus = new EventBus({ jobQueue: filteredQueue, bufferSize: 100, heartbeatInterval: 60_000 });

      try {
        const res = createMockResponse();
        // Filter for 'staging' — job-1 has it among its tags
        await bus.subscribeAll(res, { tags: ['staging'] });

        await bus.publish('job-1', createEventPayload({ jobId: 'job-1' }));

        expect(res.write).toHaveBeenCalledTimes(1);
      } finally {
        bus.destroy();
      }
    });
  });

  describe('scheduleCleanup()', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should remove buffer after grace period elapses', async () => {
      const bus = new EventBus({ jobQueue, bufferSize: 100, gracePeriod: 5000, heartbeatInterval: 60_000 });

      try {
        await bus.publish('job-1', createEventPayload({ jobId: 'job-1' }));
        expect(bus.getBufferedEvents('job-1')).toHaveLength(1);

        bus.scheduleCleanup('job-1');

        // Before grace period — buffer still exists
        vi.advanceTimersByTime(4999);
        expect(bus.getBufferedEvents('job-1')).toHaveLength(1);

        // After grace period — buffer cleaned up
        vi.advanceTimersByTime(1);
        expect(bus.getBufferedEvents('job-1')).toEqual([]);
      } finally {
        bus.destroy();
      }
    });

    it('should reset timer when scheduleCleanup is called again for the same job', async () => {
      const bus = new EventBus({ jobQueue, bufferSize: 100, gracePeriod: 5000, heartbeatInterval: 60_000 });

      try {
        await bus.publish('job-1', createEventPayload({ jobId: 'job-1' }));

        bus.scheduleCleanup('job-1');

        // Advance 3 seconds, then reschedule
        vi.advanceTimersByTime(3000);
        bus.scheduleCleanup('job-1');

        // 3 more seconds from reschedule (total 6s from start) — should still exist
        vi.advanceTimersByTime(3000);
        expect(bus.getBufferedEvents('job-1')).toHaveLength(1);

        // 2 more seconds (5s from reschedule) — now cleaned up
        vi.advanceTimersByTime(2000);
        expect(bus.getBufferedEvents('job-1')).toEqual([]);
      } finally {
        bus.destroy();
      }
    });

    it('should use default grace period of 300000ms', async () => {
      const bus = new EventBus({ jobQueue, bufferSize: 100, heartbeatInterval: 60_000 });

      try {
        await bus.publish('job-1', createEventPayload({ jobId: 'job-1' }));
        bus.scheduleCleanup('job-1');

        // Just before 5 minutes
        vi.advanceTimersByTime(299_999);
        expect(bus.getBufferedEvents('job-1')).toHaveLength(1);

        // At 5 minutes
        vi.advanceTimersByTime(1);
        expect(bus.getBufferedEvents('job-1')).toEqual([]);
      } finally {
        bus.destroy();
      }
    });
  });

  describe('closeJobSubscribers()', () => {
    it('should end all per-job subscriber connections', async () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      eventBus.subscribe('job-1', res1);
      eventBus.subscribe('job-1', res2);

      eventBus.closeJobSubscribers('job-1');

      expect(res1.end).toHaveBeenCalled();
      expect(res2.end).toHaveBeenCalled();
    });

    it('should not affect subscribers of other jobs', async () => {
      const res1 = createMockResponse();
      const res2 = createMockResponse();
      eventBus.subscribe('job-1', res1);
      eventBus.subscribe('job-2', res2);

      eventBus.closeJobSubscribers('job-1');

      expect(res1.end).toHaveBeenCalled();
      expect(res2.end).not.toHaveBeenCalled();
    });

    it('should be a no-op for unknown job', () => {
      expect(() => eventBus.closeJobSubscribers('nonexistent')).not.toThrow();
    });
  });

  describe('destroy()', () => {
    it('should close all per-job and global subscriber connections', async () => {
      const perJobRes = createMockResponse();
      const globalRes = createMockResponse();
      eventBus.subscribe('job-1', perJobRes);
      await eventBus.subscribeAll(globalRes, {});

      eventBus.destroy();

      expect(perJobRes.end).toHaveBeenCalled();
      expect(globalRes.end).toHaveBeenCalled();
    });

    it('should clear all buffers and counters', async () => {
      await eventBus.publish('job-1', createEventPayload({ jobId: 'job-1' }));
      await eventBus.publish('job-2', createEventPayload({ jobId: 'job-2' }));

      eventBus.destroy();

      expect(eventBus.getBufferedEvents('job-1')).toEqual([]);
      expect(eventBus.getBufferedEvents('job-2')).toEqual([]);
    });

    it('should clear scheduled cleanup timers', async () => {
      vi.useFakeTimers();

      try {
        const bus = new EventBus({ jobQueue, bufferSize: 100, gracePeriod: 5000, heartbeatInterval: 60_000 });
        await bus.publish('job-1', createEventPayload({ jobId: 'job-1' }));
        bus.scheduleCleanup('job-1');

        bus.destroy();

        // Advance past grace period — should not throw or cause issues
        vi.advanceTimersByTime(10_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should stop the heartbeat interval', () => {
      vi.useFakeTimers();

      try {
        const bus = new EventBus({ jobQueue, bufferSize: 100, heartbeatInterval: 1000 });
        bus.startHeartbeat();

        const res = createMockResponse();
        bus.subscribe('job-1', res);

        // Verify heartbeat is running
        vi.advanceTimersByTime(1000);
        expect(res.write).toHaveBeenCalled();
        const countBefore = (res.write as ReturnType<typeof vi.fn>).mock.calls.length;

        bus.destroy();

        // Advance more — no additional writes since heartbeat is stopped
        vi.advanceTimersByTime(5000);
        // After destroy, the subscriber was removed so write count shouldn't increase
        // The key thing is no errors are thrown
      } finally {
        vi.useRealTimers();
      }
    });

    it('should be safe to call multiple times', () => {
      expect(() => {
        eventBus.destroy();
        eventBus.destroy();
      }).not.toThrow();
    });
  });

  describe('heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should send ping comments to all per-job subscribers at configured interval', () => {
      const bus = new EventBus({ jobQueue, bufferSize: 100, heartbeatInterval: 5000 });

      try {
        const res1 = createMockResponse();
        const res2 = createMockResponse();
        bus.subscribe('job-1', res1);
        bus.subscribe('job-2', res2);

        bus.startHeartbeat();

        // No pings yet
        expect(res1.write).not.toHaveBeenCalled();
        expect(res2.write).not.toHaveBeenCalled();

        // After one interval
        vi.advanceTimersByTime(5000);
        expect(res1.write).toHaveBeenCalledTimes(1);
        expect(res2.write).toHaveBeenCalledTimes(1);
        expect(res1.writtenData[0]).toBe(': ping\n\n');
        expect(res2.writtenData[0]).toBe(': ping\n\n');

        // After second interval
        vi.advanceTimersByTime(5000);
        expect(res1.write).toHaveBeenCalledTimes(2);
        expect(res2.write).toHaveBeenCalledTimes(2);
      } finally {
        bus.destroy();
      }
    });

    it('should send ping comments to global subscribers', async () => {
      const bus = new EventBus({ jobQueue, bufferSize: 100, heartbeatInterval: 5000 });

      try {
        const res = createMockResponse();
        await bus.subscribeAll(res, {});

        bus.startHeartbeat();

        vi.advanceTimersByTime(5000);
        expect(res.write).toHaveBeenCalledTimes(1);
        expect(res.writtenData[0]).toBe(': ping\n\n');
      } finally {
        bus.destroy();
      }
    });

    it('should clean up dead connections detected during heartbeat', () => {
      const bus = new EventBus({ jobQueue, bufferSize: 100, heartbeatInterval: 5000 });

      try {
        const goodRes = createMockResponse();
        const deadRes = createMockResponse();
        (deadRes.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
          throw new Error('Connection reset');
        });

        bus.subscribe('job-1', goodRes);
        bus.subscribe('job-1', deadRes);

        bus.startHeartbeat();

        // First heartbeat — deadRes throws, gets cleaned up
        vi.advanceTimersByTime(5000);

        // Second heartbeat — only goodRes should be pinged
        vi.advanceTimersByTime(5000);

        // goodRes gets 2 pings (one per interval)
        expect(goodRes.write).toHaveBeenCalledTimes(2);
        // deadRes only got 1 call (the one that threw)
        expect(deadRes.write).toHaveBeenCalledTimes(1);
      } finally {
        bus.destroy();
      }
    });

    it('should clean up dead global subscribers during heartbeat', async () => {
      const bus = new EventBus({ jobQueue, bufferSize: 100, heartbeatInterval: 5000 });

      try {
        const goodRes = createMockResponse();
        const deadRes = createMockResponse();
        (deadRes.write as ReturnType<typeof vi.fn>).mockImplementation(() => {
          throw new Error('Connection reset');
        });

        await bus.subscribeAll(goodRes, {});
        await bus.subscribeAll(deadRes, {});

        bus.startHeartbeat();

        // First heartbeat — deadRes throws, gets cleaned up
        vi.advanceTimersByTime(5000);

        // Second heartbeat — only goodRes should be pinged
        vi.advanceTimersByTime(5000);

        expect(goodRes.write).toHaveBeenCalledTimes(2);
        expect(deadRes.write).toHaveBeenCalledTimes(1);
      } finally {
        bus.destroy();
      }
    });

    it('should not start multiple heartbeat intervals', () => {
      const bus = new EventBus({ jobQueue, bufferSize: 100, heartbeatInterval: 5000 });

      try {
        const res = createMockResponse();
        bus.subscribe('job-1', res);

        bus.startHeartbeat();
        bus.startHeartbeat(); // Second call should be a no-op

        vi.advanceTimersByTime(5000);
        // Should get exactly 1 ping, not 2
        expect(res.write).toHaveBeenCalledTimes(1);
      } finally {
        bus.destroy();
      }
    });

    it('should allow stopping and restarting heartbeat', () => {
      const bus = new EventBus({ jobQueue, bufferSize: 100, heartbeatInterval: 5000 });

      try {
        const res = createMockResponse();
        bus.subscribe('job-1', res);

        bus.startHeartbeat();
        vi.advanceTimersByTime(5000);
        expect(res.write).toHaveBeenCalledTimes(1);

        bus.stopHeartbeat();
        vi.advanceTimersByTime(10_000);
        // No new pings after stop
        expect(res.write).toHaveBeenCalledTimes(1);

        bus.startHeartbeat();
        vi.advanceTimersByTime(5000);
        // One more ping after restart
        expect(res.write).toHaveBeenCalledTimes(2);
      } finally {
        bus.destroy();
      }
    });

    it('should use default heartbeat interval of 30000ms', () => {
      const bus = new EventBus({ jobQueue, bufferSize: 100 });

      try {
        const res = createMockResponse();
        bus.subscribe('job-1', res);

        bus.startHeartbeat();

        // At 29999ms — no ping yet
        vi.advanceTimersByTime(29_999);
        expect(res.write).not.toHaveBeenCalled();

        // At 30000ms — first ping
        vi.advanceTimersByTime(1);
        expect(res.write).toHaveBeenCalledTimes(1);
      } finally {
        bus.destroy();
      }
    });
  });

  describe('SSE frame format', () => {
    it('should format events as valid SSE frames', async () => {
      const res = createMockResponse();
      eventBus.subscribe('job-1', res);

      await eventBus.publish('job-1', createEventPayload({
        type: 'job:status',
        jobId: 'job-1',
        data: { status: 'completed' },
      }));

      const raw = res.writtenData[0]!;
      // Should have event, id, data fields followed by blank line
      expect(raw).toMatch(/^event: job:status\n/);
      expect(raw).toMatch(/\nid: 1\n/);
      expect(raw).toMatch(/\ndata: \{.*\}\n\n$/);

      // Data field should be valid JSON matching the full event
      const dataLine = raw.split('\n').find((l) => l.startsWith('data: '))!;
      const parsed = JSON.parse(dataLine.slice(6));
      expect(parsed.id).toBe('1');
      expect(parsed.type).toBe('job:status');
      expect(parsed.jobId).toBe('job-1');
    });
  });

  // ---------------------------------------------------------------------------
  // T022: EventBus log routing — log:append → LogBufferManager
  // ---------------------------------------------------------------------------

  describe('log routing (log:append → LogBufferManager)', () => {
    let logBufferManager: LogBufferManager;
    let logBus: EventBus;

    beforeEach(() => {
      logBufferManager = new LogBufferManager();
      logBus = new EventBus({
        jobQueue,
        logBufferManager,
        bufferSize: 100,
        gracePeriod: 5000,
        heartbeatInterval: 60_000,
      });
    });

    afterEach(() => {
      logBus.destroy();
      logBufferManager.destroy();
    });

    it('should route log:append events to LogBufferManager instead of RingBuffer', async () => {
      await logBus.publish('job-1', createEventPayload({
        type: 'log:append',
        jobId: 'job-1',
        data: {
          stream: 'stdout',
          stepName: 'specify',
          content: 'Reading files...',
        },
      }));

      // Log event should be in the LogBufferManager
      const logBuffer = logBufferManager.get('job-1');
      expect(logBuffer).toBeDefined();
      expect(logBuffer!.size).toBe(1);

      const entries = logBuffer!.getAll();
      expect(entries[0]).toMatchObject({
        stream: 'stdout',
        stepName: 'specify',
        content: 'Reading files...',
      });

      // Log event should NOT be in the per-job RingBuffer
      expect(logBus.getBufferedEvents('job-1')).toHaveLength(0);
    });

    it('should store lifecycle events in the per-job RingBuffer (not LogBufferManager)', async () => {
      await logBus.publish('job-1', createEventPayload({
        type: 'step:start',
        jobId: 'job-1',
        data: { step: 'compile' },
      }));

      await logBus.publish('job-1', createEventPayload({
        type: 'phase:complete',
        jobId: 'job-1',
        data: { phase: 'build' },
      }));

      // Lifecycle events should be in the RingBuffer
      const buffered = logBus.getBufferedEvents('job-1');
      expect(buffered).toHaveLength(2);
      expect(buffered[0].type).toBe('step:start');
      expect(buffered[1].type).toBe('phase:complete');

      // No log buffer created (no log:append events)
      expect(logBufferManager.get('job-1')).toBeUndefined();
    });

    it('should broadcast log:append events via SSE to per-job subscribers', async () => {
      const res = createMockResponse();
      logBus.subscribe('job-1', res);

      await logBus.publish('job-1', createEventPayload({
        type: 'log:append',
        jobId: 'job-1',
        data: {
          stream: 'stdout',
          stepName: 'plan',
          content: 'Planning step...',
        },
      }));

      // SSE broadcast should still happen for log:append events
      expect(res.write).toHaveBeenCalledTimes(1);
      const frame = parseSSEFrame(res.writtenData[0]!);
      expect(frame.event).toBe('log:append');
      expect(frame.data?.type).toBe('log:append');
    });

    it('should broadcast lifecycle events via SSE to per-job subscribers', async () => {
      const res = createMockResponse();
      logBus.subscribe('job-1', res);

      await logBus.publish('job-1', createEventPayload({
        type: 'step:complete',
        jobId: 'job-1',
        data: { step: 'compile' },
      }));

      expect(res.write).toHaveBeenCalledTimes(1);
      const frame = parseSSEFrame(res.writtenData[0]!);
      expect(frame.event).toBe('step:complete');
    });

    it('should broadcast both log and lifecycle events to the same SSE subscriber', async () => {
      const res = createMockResponse();
      logBus.subscribe('job-1', res);

      await logBus.publish('job-1', createEventPayload({
        type: 'step:start',
        jobId: 'job-1',
      }));
      await logBus.publish('job-1', createEventPayload({
        type: 'log:append',
        jobId: 'job-1',
        data: { stream: 'stdout', stepName: 'specify', content: 'output' },
      }));
      await logBus.publish('job-1', createEventPayload({
        type: 'step:complete',
        jobId: 'job-1',
      }));

      expect(res.write).toHaveBeenCalledTimes(3);
      const frames = res.writtenData.map(parseSSEFrame);
      expect(frames[0]!.event).toBe('step:start');
      expect(frames[1]!.event).toBe('log:append');
      expect(frames[2]!.event).toBe('step:complete');
    });

    it('should broadcast log:append events to global SSE subscribers', async () => {
      const res = createMockResponse();
      await logBus.subscribeAll(res, {});

      await logBus.publish('job-1', createEventPayload({
        type: 'log:append',
        jobId: 'job-1',
        data: { stream: 'stderr', stepName: 'implement', content: 'error output' },
      }));

      expect(res.write).toHaveBeenCalledTimes(1);
      const frame = parseSSEFrame(res.writtenData[0]!);
      expect(frame.event).toBe('log:append');
    });

    it('should extract all log fields from event data into LogBuffer entry', async () => {
      await logBus.publish('job-1', createEventPayload({
        type: 'log:append',
        jobId: 'job-1',
        timestamp: 1700000000000,
        data: {
          stream: 'stderr',
          stepName: 'implement',
          content: 'Compiling task...',
          taskIndex: 3,
          taskTitle: 'Add error handling',
        },
      }));

      const entries = logBufferManager.get('job-1')!.getAll();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        timestamp: 1700000000000,
        stream: 'stderr',
        stepName: 'implement',
        content: 'Compiling task...',
        taskIndex: 3,
        taskTitle: 'Add error handling',
      });
    });

    it('should assign monotonic event IDs across both log and lifecycle events', async () => {
      const e1 = await logBus.publish('job-1', createEventPayload({
        type: 'step:start',
        jobId: 'job-1',
      }));
      const e2 = await logBus.publish('job-1', createEventPayload({
        type: 'log:append',
        jobId: 'job-1',
        data: { stream: 'stdout', stepName: 'specify', content: 'chunk' },
      }));
      const e3 = await logBus.publish('job-1', createEventPayload({
        type: 'step:complete',
        jobId: 'job-1',
      }));

      expect(e1.id).toBe('1');
      expect(e2.id).toBe('2');
      expect(e3.id).toBe('3');
    });

    it('should route multiple log:append events to the same LogBuffer', async () => {
      await logBus.publish('job-1', createEventPayload({
        type: 'log:append',
        jobId: 'job-1',
        data: { stream: 'stdout', stepName: 'specify', content: 'first' },
      }));
      await logBus.publish('job-1', createEventPayload({
        type: 'log:append',
        jobId: 'job-1',
        data: { stream: 'stdout', stepName: 'specify', content: 'second' },
      }));
      await logBus.publish('job-1', createEventPayload({
        type: 'log:append',
        jobId: 'job-1',
        data: { stream: 'stderr', stepName: 'specify', content: 'third' },
      }));

      const entries = logBufferManager.get('job-1')!.getAll();
      expect(entries).toHaveLength(3);
      expect(entries[0].content).toBe('first');
      expect(entries[1].content).toBe('second');
      expect(entries[2].content).toBe('third');

      // RingBuffer should remain empty
      expect(logBus.getBufferedEvents('job-1')).toHaveLength(0);
    });

    describe('scheduleCleanup with LogBufferManager', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('should trigger LogBufferManager.scheduleCleanup when EventBus.scheduleCleanup is called', async () => {
        const scheduleSpy = vi.spyOn(logBufferManager, 'scheduleCleanup');

        await logBus.publish('job-1', createEventPayload({
          type: 'log:append',
          jobId: 'job-1',
          data: { stream: 'stdout', stepName: 'specify', content: 'data' },
        }));

        logBus.scheduleCleanup('job-1');

        expect(scheduleSpy).toHaveBeenCalledWith('job-1');
        expect(scheduleSpy).toHaveBeenCalledTimes(1);
      });

      it('should clean up both lifecycle RingBuffer and LogBuffer after grace period', async () => {
        // Recreate with fake timers active
        logBus.destroy();
        logBufferManager.destroy();
        logBufferManager = new LogBufferManager({ gracePeriod: 5000 });
        logBus = new EventBus({
          jobQueue,
          logBufferManager,
          bufferSize: 100,
          gracePeriod: 5000,
          heartbeatInterval: 60_000,
        });

        await logBus.publish('job-1', createEventPayload({
          type: 'step:start',
          jobId: 'job-1',
        }));
        await logBus.publish('job-1', createEventPayload({
          type: 'log:append',
          jobId: 'job-1',
          data: { stream: 'stdout', stepName: 'specify', content: 'output' },
        }));

        // Both should exist before cleanup
        expect(logBus.getBufferedEvents('job-1')).toHaveLength(1);
        expect(logBufferManager.get('job-1')!.size).toBe(1);

        logBus.scheduleCleanup('job-1');

        // Both still exist before grace period
        vi.advanceTimersByTime(4999);
        expect(logBus.getBufferedEvents('job-1')).toHaveLength(1);
        expect(logBufferManager.get('job-1')).toBeDefined();

        // After grace period — both cleaned up
        vi.advanceTimersByTime(1);
        expect(logBus.getBufferedEvents('job-1')).toHaveLength(0);
        expect(logBufferManager.get('job-1')).toBeUndefined();
      });

      it('should handle scheduleCleanup for jobs with only log events', async () => {
        logBus.destroy();
        logBufferManager.destroy();
        logBufferManager = new LogBufferManager({ gracePeriod: 5000 });
        logBus = new EventBus({
          jobQueue,
          logBufferManager,
          bufferSize: 100,
          gracePeriod: 5000,
          heartbeatInterval: 60_000,
        });

        await logBus.publish('job-1', createEventPayload({
          type: 'log:append',
          jobId: 'job-1',
          data: { stream: 'stdout', stepName: 'plan', content: 'planning...' },
        }));

        logBus.scheduleCleanup('job-1');
        vi.advanceTimersByTime(5000);

        expect(logBufferManager.get('job-1')).toBeUndefined();
      });
    });

    it('should fall back to RingBuffer for log:append when no LogBufferManager is provided', async () => {
      const busWithoutLogManager = new EventBus({
        jobQueue,
        bufferSize: 100,
        heartbeatInterval: 60_000,
      });

      try {
        await busWithoutLogManager.publish('job-1', createEventPayload({
          type: 'log:append',
          jobId: 'job-1',
          data: { stream: 'stdout', stepName: 'specify', content: 'fallback' },
        }));

        // Without LogBufferManager, log events go to the RingBuffer
        const buffered = busWithoutLogManager.getBufferedEvents('job-1');
        expect(buffered).toHaveLength(1);
        expect(buffered[0].type).toBe('log:append');
      } finally {
        busWithoutLogManager.destroy();
      }
    });
  });
});
