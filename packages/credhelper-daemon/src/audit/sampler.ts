/**
 * Deterministic counter-based sampler for proxy audit hooks.
 * Fires every Nth request (default 1/100). The `recordAllProxy`
 * override sets the rate to 100% (fire on every request).
 */
export class AuditSampler {
  private counter = 0;

  constructor(private readonly rate: number = 100) {}

  /** Returns true if this request should be recorded. */
  shouldRecord(recordAllProxy?: boolean): boolean {
    if (recordAllProxy) return true;
    this.counter++;
    if (this.counter >= this.rate) {
      this.counter = 0;
      return true;
    }
    return false;
  }

  /** Reset the internal counter (for testing). */
  reset(): void {
    this.counter = 0;
  }
}
