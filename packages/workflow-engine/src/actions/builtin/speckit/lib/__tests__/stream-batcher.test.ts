/**
 * Unit tests for StreamBatcher.
 *
 * Verifies that:
 * - Chunks are batched within the interval and flushed on timeout
 * - flush() immediately emits buffered content and clears timer
 * - Empty flush() is a no-op (does not call flushCallback)
 * - Multiple rapid append() calls result in a single flush
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamBatcher } from '../stream-batcher.js';

describe('StreamBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should batch chunks within the interval and flush on timeout', () => {
    const flushCallback = vi.fn();
    const batcher = new StreamBatcher(flushCallback, 200);

    batcher.append('hello ');
    batcher.append('world');

    // Not flushed yet
    expect(flushCallback).not.toHaveBeenCalled();

    // Advance past the interval
    vi.advanceTimersByTime(200);

    expect(flushCallback).toHaveBeenCalledOnce();
    expect(flushCallback).toHaveBeenCalledWith('hello world');
  });

  it('should flush() immediately emit buffered content and clear timer', () => {
    const flushCallback = vi.fn();
    const batcher = new StreamBatcher(flushCallback, 200);

    batcher.append('chunk1');
    batcher.append('chunk2');

    // Manual flush before timer fires
    batcher.flush();

    expect(flushCallback).toHaveBeenCalledOnce();
    expect(flushCallback).toHaveBeenCalledWith('chunk1chunk2');

    // Advancing timer should not cause another flush (timer was cleared)
    vi.advanceTimersByTime(200);
    expect(flushCallback).toHaveBeenCalledOnce();
  });

  it('should not call flushCallback when flush() is called with empty buffer', () => {
    const flushCallback = vi.fn();
    const batcher = new StreamBatcher(flushCallback, 200);

    batcher.flush();

    expect(flushCallback).not.toHaveBeenCalled();
  });

  it('should not call flushCallback when flush() is called after buffer already drained', () => {
    const flushCallback = vi.fn();
    const batcher = new StreamBatcher(flushCallback, 200);

    batcher.append('data');
    batcher.flush();
    expect(flushCallback).toHaveBeenCalledOnce();

    // Second flush should be a no-op
    batcher.flush();
    expect(flushCallback).toHaveBeenCalledOnce();
  });

  it('should result in a single flush for multiple rapid append() calls', () => {
    const flushCallback = vi.fn();
    const batcher = new StreamBatcher(flushCallback, 200);

    batcher.append('a');
    batcher.append('b');
    batcher.append('c');
    batcher.append('d');
    batcher.append('e');

    vi.advanceTimersByTime(200);

    expect(flushCallback).toHaveBeenCalledOnce();
    expect(flushCallback).toHaveBeenCalledWith('abcde');
  });

  it('should start a new batch after a flush', () => {
    const flushCallback = vi.fn();
    const batcher = new StreamBatcher(flushCallback, 200);

    batcher.append('first');
    vi.advanceTimersByTime(200);

    expect(flushCallback).toHaveBeenCalledOnce();
    expect(flushCallback).toHaveBeenCalledWith('first');

    // New batch
    batcher.append('second');
    vi.advanceTimersByTime(200);

    expect(flushCallback).toHaveBeenCalledTimes(2);
    expect(flushCallback).toHaveBeenLastCalledWith('second');
  });

  it('should use default interval of 200ms', () => {
    const flushCallback = vi.fn();
    const batcher = new StreamBatcher(flushCallback);

    batcher.append('data');

    // Not flushed at 199ms
    vi.advanceTimersByTime(199);
    expect(flushCallback).not.toHaveBeenCalled();

    // Flushed at 200ms
    vi.advanceTimersByTime(1);
    expect(flushCallback).toHaveBeenCalledOnce();
    expect(flushCallback).toHaveBeenCalledWith('data');
  });

  it('should respect custom interval', () => {
    const flushCallback = vi.fn();
    const batcher = new StreamBatcher(flushCallback, 500);

    batcher.append('data');

    vi.advanceTimersByTime(200);
    expect(flushCallback).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(flushCallback).toHaveBeenCalledOnce();
    expect(flushCallback).toHaveBeenCalledWith('data');
  });

  it('should only start timer on first append, not on subsequent appends', () => {
    const flushCallback = vi.fn();
    const batcher = new StreamBatcher(flushCallback, 200);

    batcher.append('a');
    vi.advanceTimersByTime(100);

    // Append more data halfway through the interval
    batcher.append('b');
    vi.advanceTimersByTime(100);

    // Timer started with first append, so it fires at 200ms from first append
    expect(flushCallback).toHaveBeenCalledOnce();
    expect(flushCallback).toHaveBeenCalledWith('ab');
  });

  it('should handle append after manual flush within same interval window', () => {
    const flushCallback = vi.fn();
    const batcher = new StreamBatcher(flushCallback, 200);

    batcher.append('before');
    batcher.flush();
    expect(flushCallback).toHaveBeenCalledWith('before');

    batcher.append('after');
    vi.advanceTimersByTime(200);

    expect(flushCallback).toHaveBeenCalledTimes(2);
    expect(flushCallback).toHaveBeenLastCalledWith('after');
  });
});
