/**
 * Batches string chunks over a time window and calls a flush callback.
 * Used to reduce event volume from high-frequency stdout data events.
 */
export class StreamBatcher {
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flushCallback: (content: string) => void,
    private readonly intervalMs: number = 200,
  ) {}

  append(chunk: string): void {
    this.buffer += chunk;
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length > 0) {
      this.flushCallback(this.buffer);
      this.buffer = '';
    }
  }
}
