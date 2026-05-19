/**
 * Generic bounded ring buffer with O(1) push and bulk drain.
 * When capacity is exceeded, the oldest entries are silently dropped.
 */
export class RingBuffer<T> {
  private readonly buffer: (T | undefined)[];
  private head = 0;
  private tail = 0;
  private count = 0;
  private dropped = 0;

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new RangeError('RingBuffer capacity must be >= 1');
    this.buffer = new Array<T | undefined>(capacity);
  }

  /** Push an entry. Drops the oldest if at capacity. */
  push(entry: T): void {
    if (this.count === this.capacity) {
      // Overwrite oldest — advance tail
      this.tail = (this.tail + 1) % this.capacity;
      this.dropped++;
    } else {
      this.count++;
    }
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
  }

  /**
   * Drain up to `max` entries (FIFO order).
   * Resets the dropped counter after each drain.
   */
  drain(max: number): { entries: T[]; dropped: number } {
    const n = Math.min(max, this.count);
    const entries: T[] = [];

    for (let i = 0; i < n; i++) {
      entries.push(this.buffer[this.tail]!);
      this.buffer[this.tail] = undefined;
      this.tail = (this.tail + 1) % this.capacity;
    }

    this.count -= n;
    const droppedCount = this.dropped;
    this.dropped = 0;
    return { entries, dropped: droppedCount };
  }

  /** Current number of entries in the buffer. */
  get size(): number {
    return this.count;
  }

  /** Number of entries dropped since last drain. */
  get droppedCount(): number {
    return this.dropped;
  }
}
