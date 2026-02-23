/**
 * Unit tests for LogBuffer and LogBufferManager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LogBuffer, LogBufferManager, type LogEntry } from '../log-buffer.js';

/** Helper to create a minimal log entry (without `id`, which is assigned by `append()`). */
function makeEntry(overrides: Partial<Omit<LogEntry, 'id'>> = {}): Omit<LogEntry, 'id'> {
  return {
    timestamp: Date.now(),
    stream: 'stdout',
    stepName: 'specify',
    content: 'hello',
    ...overrides,
  };
}

describe('LogBuffer', () => {
  let buf: LogBuffer;

  beforeEach(() => {
    buf = new LogBuffer();
  });

  describe('append()', () => {
    it('should assign monotonic IDs starting at 1', () => {
      const e1 = buf.append(makeEntry({ content: 'first' }));
      const e2 = buf.append(makeEntry({ content: 'second' }));
      const e3 = buf.append(makeEntry({ content: 'third' }));

      expect(e1.id).toBe(1);
      expect(e2.id).toBe(2);
      expect(e3.id).toBe(3);
    });

    it('should return the full entry including the assigned id', () => {
      const input = makeEntry({ content: 'test', stepName: 'plan' });
      const result = buf.append(input);

      expect(result).toMatchObject({
        id: 1,
        content: 'test',
        stepName: 'plan',
        stream: 'stdout',
      });
    });

    it('should preserve optional taskIndex and taskTitle fields', () => {
      const result = buf.append(
        makeEntry({ stepName: 'implement', taskIndex: 2, taskTitle: 'Add tests' }),
      );

      expect(result.taskIndex).toBe(2);
      expect(result.taskTitle).toBe('Add tests');
    });

    it('should increment size', () => {
      expect(buf.size).toBe(0);

      buf.append(makeEntry());
      expect(buf.size).toBe(1);

      buf.append(makeEntry());
      expect(buf.size).toBe(2);
    });
  });

  describe('getAll()', () => {
    it('should return empty array when buffer is empty', () => {
      expect(buf.getAll()).toEqual([]);
    });

    it('should return all entries in insertion order', () => {
      buf.append(makeEntry({ content: 'a' }));
      buf.append(makeEntry({ content: 'b' }));
      buf.append(makeEntry({ content: 'c' }));

      const all = buf.getAll();
      expect(all).toHaveLength(3);
      expect(all[0].content).toBe('a');
      expect(all[1].content).toBe('b');
      expect(all[2].content).toBe('c');
    });

    it('should return entries with correct IDs', () => {
      buf.append(makeEntry());
      buf.append(makeEntry());
      buf.append(makeEntry());

      const ids = buf.getAll().map((e) => e.id);
      expect(ids).toEqual([1, 2, 3]);
    });
  });

  describe('getAfterId()', () => {
    it('should return entries after the specified ID', () => {
      buf.append(makeEntry({ content: 'a' }));
      buf.append(makeEntry({ content: 'b' }));
      buf.append(makeEntry({ content: 'c' }));
      buf.append(makeEntry({ content: 'd' }));

      const after2 = buf.getAfterId(2);
      expect(after2).toHaveLength(2);
      expect(after2[0].content).toBe('c');
      expect(after2[1].content).toBe('d');
    });

    it('should return empty array when sinceId is the last entry', () => {
      buf.append(makeEntry());
      buf.append(makeEntry());
      buf.append(makeEntry());

      expect(buf.getAfterId(3)).toEqual([]);
    });

    it('should return empty array when sinceId is beyond the last entry', () => {
      buf.append(makeEntry());
      buf.append(makeEntry());

      expect(buf.getAfterId(5)).toEqual([]);
    });

    it('should return all entries when sinceId is 0', () => {
      buf.append(makeEntry({ content: 'x' }));
      buf.append(makeEntry({ content: 'y' }));

      const all = buf.getAfterId(0);
      expect(all).toHaveLength(2);
      expect(all[0].content).toBe('x');
      expect(all[1].content).toBe('y');
    });

    it('should return all entries when sinceId is negative', () => {
      buf.append(makeEntry());
      buf.append(makeEntry());

      expect(buf.getAfterId(-1)).toHaveLength(2);
    });

    it('should return empty array on an empty buffer', () => {
      expect(buf.getAfterId(0)).toEqual([]);
    });
  });

  describe('capacity eviction', () => {
    it('should evict oldest entries when buffer is full', () => {
      const small = new LogBuffer(3);

      small.append(makeEntry({ content: 'a' })); // id=1
      small.append(makeEntry({ content: 'b' })); // id=2
      small.append(makeEntry({ content: 'c' })); // id=3
      small.append(makeEntry({ content: 'd' })); // id=4 — evicts 'a'

      expect(small.size).toBe(3);

      const all = small.getAll();
      expect(all).toHaveLength(3);
      expect(all[0].content).toBe('b');
      expect(all[1].content).toBe('c');
      expect(all[2].content).toBe('d');
    });

    it('should still assign monotonic IDs after eviction', () => {
      const small = new LogBuffer(2);

      small.append(makeEntry()); // id=1
      small.append(makeEntry()); // id=2
      const e3 = small.append(makeEntry()); // id=3

      expect(e3.id).toBe(3);

      const all = small.getAll();
      expect(all.map((e) => e.id)).toEqual([2, 3]);
    });

    it('should handle getAfterId correctly after eviction', () => {
      const small = new LogBuffer(3);

      small.append(makeEntry({ content: 'a' })); // id=1
      small.append(makeEntry({ content: 'b' })); // id=2
      small.append(makeEntry({ content: 'c' })); // id=3
      small.append(makeEntry({ content: 'd' })); // id=4 — evicts 'a'
      small.append(makeEntry({ content: 'e' })); // id=5 — evicts 'b'

      // sinceId=1 is already evicted, should return all remaining
      const afterEvicted = small.getAfterId(1);
      expect(afterEvicted).toHaveLength(3);
      expect(afterEvicted[0].content).toBe('c');

      // sinceId=3 should return entries after id=3
      const after3 = small.getAfterId(3);
      expect(after3).toHaveLength(2);
      expect(after3[0].content).toBe('d');
      expect(after3[1].content).toBe('e');
    });
  });

  describe('clear()', () => {
    it('should reset buffer and counter', () => {
      buf.append(makeEntry());
      buf.append(makeEntry());
      buf.append(makeEntry());

      expect(buf.size).toBe(3);

      buf.clear();

      expect(buf.size).toBe(0);
      expect(buf.getAll()).toEqual([]);
    });

    it('should reset ID counter so new entries start at 1 again', () => {
      buf.append(makeEntry());
      buf.append(makeEntry());
      buf.clear();

      const e = buf.append(makeEntry());
      expect(e.id).toBe(1);
    });
  });

  describe('size', () => {
    it('should reflect the current number of entries', () => {
      expect(buf.size).toBe(0);

      buf.append(makeEntry());
      expect(buf.size).toBe(1);

      buf.append(makeEntry());
      buf.append(makeEntry());
      expect(buf.size).toBe(3);
    });

    it('should not exceed capacity', () => {
      const small = new LogBuffer(2);

      small.append(makeEntry());
      small.append(makeEntry());
      small.append(makeEntry());
      small.append(makeEntry());

      expect(small.size).toBe(2);
    });
  });
});

describe('LogBufferManager', () => {
  let manager: LogBufferManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new LogBufferManager();
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  describe('getOrCreate()', () => {
    it('should create a new buffer on first access', () => {
      const buf = manager.getOrCreate('job-1');

      expect(buf).toBeInstanceOf(LogBuffer);
      expect(buf.size).toBe(0);
    });

    it('should return the same buffer on subsequent access', () => {
      const buf1 = manager.getOrCreate('job-1');
      buf1.append(makeEntry({ content: 'test' }));

      const buf2 = manager.getOrCreate('job-1');

      expect(buf2).toBe(buf1);
      expect(buf2.size).toBe(1);
    });

    it('should create separate buffers for different jobs', () => {
      const buf1 = manager.getOrCreate('job-1');
      const buf2 = manager.getOrCreate('job-2');

      expect(buf1).not.toBe(buf2);

      buf1.append(makeEntry({ content: 'job-1-entry' }));
      expect(buf2.size).toBe(0);
    });

    it('should use configured capacity for new buffers', () => {
      const mgr = new LogBufferManager({ capacity: 5 });
      const buf = mgr.getOrCreate('job-1');

      for (let i = 0; i < 10; i++) {
        buf.append(makeEntry({ content: `entry-${i}` }));
      }

      expect(buf.size).toBe(5);
      mgr.destroy();
    });
  });

  describe('get()', () => {
    it('should return undefined for unknown jobs', () => {
      expect(manager.get('nonexistent')).toBeUndefined();
    });

    it('should return the buffer after getOrCreate', () => {
      const created = manager.getOrCreate('job-1');
      const fetched = manager.get('job-1');

      expect(fetched).toBe(created);
    });

    it('should not create a buffer as a side effect', () => {
      manager.get('job-1');

      expect(manager.get('job-1')).toBeUndefined();
    });
  });

  describe('scheduleCleanup()', () => {
    it('should remove the buffer after the grace period', () => {
      const buf = manager.getOrCreate('job-1');
      buf.append(makeEntry());

      manager.scheduleCleanup('job-1');

      // Buffer still exists before grace period
      expect(manager.get('job-1')).toBe(buf);

      // Advance past the default 5-minute grace period
      vi.advanceTimersByTime(300_000);

      expect(manager.get('job-1')).toBeUndefined();
    });

    it('should clear the buffer contents on cleanup', () => {
      const buf = manager.getOrCreate('job-1');
      buf.append(makeEntry());
      buf.append(makeEntry());

      manager.scheduleCleanup('job-1');
      vi.advanceTimersByTime(300_000);

      // The buffer reference was removed from the manager, and its contents cleared
      expect(buf.size).toBe(0);
    });

    it('should reset an existing cleanup timer', () => {
      manager.getOrCreate('job-1');

      manager.scheduleCleanup('job-1');

      // Advance 4 minutes — still within the first 5-minute window
      vi.advanceTimersByTime(240_000);
      expect(manager.get('job-1')).toBeDefined();

      // Reschedule — resets the timer
      manager.scheduleCleanup('job-1');

      // Advance another 4 minutes — within the new 5-minute window
      vi.advanceTimersByTime(240_000);
      expect(manager.get('job-1')).toBeDefined();

      // Advance past the new window
      vi.advanceTimersByTime(60_001);
      expect(manager.get('job-1')).toBeUndefined();
    });

    it('should use the configured grace period', () => {
      const mgr = new LogBufferManager({ gracePeriod: 1000 });
      mgr.getOrCreate('job-1');

      mgr.scheduleCleanup('job-1');

      vi.advanceTimersByTime(999);
      expect(mgr.get('job-1')).toBeDefined();

      vi.advanceTimersByTime(1);
      expect(mgr.get('job-1')).toBeUndefined();

      mgr.destroy();
    });

    it('should handle cleanup for multiple jobs independently', () => {
      manager.getOrCreate('job-1');
      manager.getOrCreate('job-2');

      manager.scheduleCleanup('job-1');

      // Advance halfway
      vi.advanceTimersByTime(150_000);

      manager.scheduleCleanup('job-2');

      // Advance to job-1's cleanup time
      vi.advanceTimersByTime(150_000);

      expect(manager.get('job-1')).toBeUndefined();
      expect(manager.get('job-2')).toBeDefined();

      // Advance to job-2's cleanup time
      vi.advanceTimersByTime(150_000);
      expect(manager.get('job-2')).toBeUndefined();
    });
  });

  describe('destroy()', () => {
    it('should clear all timers and buffers', () => {
      manager.getOrCreate('job-1');
      manager.getOrCreate('job-2');
      manager.getOrCreate('job-3');

      manager.scheduleCleanup('job-1');
      manager.scheduleCleanup('job-2');

      manager.destroy();

      expect(manager.get('job-1')).toBeUndefined();
      expect(manager.get('job-2')).toBeUndefined();
      expect(manager.get('job-3')).toBeUndefined();
    });

    it('should prevent scheduled cleanups from firing after destroy', () => {
      const buf = manager.getOrCreate('job-1');
      buf.append(makeEntry());

      manager.scheduleCleanup('job-1');
      manager.destroy();

      // Advance past the grace period — timer should have been cleared
      vi.advanceTimersByTime(600_000);

      // Buffer reference is gone from manager (destroy cleared it),
      // but the timer shouldn't fire and cause errors
      expect(manager.get('job-1')).toBeUndefined();
    });

    it('should be safe to call multiple times', () => {
      manager.getOrCreate('job-1');
      manager.scheduleCleanup('job-1');

      expect(() => {
        manager.destroy();
        manager.destroy();
      }).not.toThrow();
    });
  });
});
