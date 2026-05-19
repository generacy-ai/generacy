import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../../src/audit/ring-buffer.js';

describe('RingBuffer', () => {
  it('pushes and drains entries in FIFO order', () => {
    const rb = new RingBuffer<number>(10);
    rb.push(1);
    rb.push(2);
    rb.push(3);

    const result = rb.drain(10);
    expect(result.entries).toEqual([1, 2, 3]);
    expect(result.dropped).toBe(0);
  });

  it('reports correct size', () => {
    const rb = new RingBuffer<number>(5);
    expect(rb.size).toBe(0);
    rb.push(1);
    rb.push(2);
    expect(rb.size).toBe(2);
    rb.drain(1);
    expect(rb.size).toBe(1);
  });

  it('drops oldest entries when capacity is exceeded', () => {
    const rb = new RingBuffer<number>(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4); // drops 1
    rb.push(5); // drops 2

    expect(rb.size).toBe(3);
    const result = rb.drain(10);
    expect(result.entries).toEqual([3, 4, 5]);
    expect(result.dropped).toBe(2);
  });

  it('resets dropped counter after drain', () => {
    const rb = new RingBuffer<number>(2);
    rb.push(1);
    rb.push(2);
    rb.push(3); // drops 1

    const first = rb.drain(10);
    expect(first.dropped).toBe(1);

    rb.push(10);
    const second = rb.drain(10);
    expect(second.dropped).toBe(0);
    expect(second.entries).toEqual([10]);
  });

  it('drains up to max requested entries', () => {
    const rb = new RingBuffer<number>(10);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.push(4);
    rb.push(5);

    const result = rb.drain(3);
    expect(result.entries).toEqual([1, 2, 3]);
    expect(rb.size).toBe(2);
  });

  it('returns empty array when draining an empty buffer', () => {
    const rb = new RingBuffer<string>(5);
    const result = rb.drain(10);
    expect(result.entries).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  it('handles capacity of 1', () => {
    const rb = new RingBuffer<number>(1);
    rb.push(1);
    rb.push(2); // drops 1
    expect(rb.size).toBe(1);
    const result = rb.drain(10);
    expect(result.entries).toEqual([2]);
    expect(result.dropped).toBe(1);
  });

  it('throws on invalid capacity', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new RingBuffer(-1)).toThrow(RangeError);
  });

  it('tracks droppedCount before drain', () => {
    const rb = new RingBuffer<number>(2);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    expect(rb.droppedCount).toBe(1);
  });

  it('handles wrap-around correctly after partial drains', () => {
    const rb = new RingBuffer<number>(4);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    rb.drain(2); // drain 1, 2
    rb.push(4);
    rb.push(5);
    rb.push(6);
    const result = rb.drain(10);
    expect(result.entries).toEqual([3, 4, 5, 6]);
  });
});
