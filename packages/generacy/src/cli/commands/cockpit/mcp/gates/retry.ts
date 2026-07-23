/**
 * Pure retry helper for the two read-only gate MCP tools (#1038 T031).
 *
 * Design decisions (spec Q3 → D, plan D-2, research R2):
 *   - 3 attempts total (initial + 2 retries).
 *   - Schedule: 0 ms → 1500 ms → 3500 ms (sum = 5000 ms wall-clock budget).
 *   - `shouldRetry(err, attempt)` distinguishes retryable transport failures
 *     from terminal bugs (4xx, malformed 2xx). Returning `false` short-circuits
 *     regardless of remaining attempts.
 *
 * The retry lives at the tool boundary — the shared HTTP client stays single-
 * call so it remains testable in isolation and the write-path client keeps
 * its "one HTTP call, one policy" contract from #1022.
 */

export interface RetrySchedule {
  /** Delay before each attempt in ms. First entry is typically 0. */
  readonly delays: readonly number[];
}

/**
 * Bounded retry schedule for `cockpit_gate_status` / `cockpit_gate_list`
 * (Q3 → D locked). Frozen so tests + callers cannot mutate.
 */
export const QUERY_RETRY_SCHEDULE: RetrySchedule = Object.freeze({
  delays: Object.freeze([0, 1500, 3500]),
});

export interface WithRetryOptions<T> {
  fn: (attempt: number) => Promise<T>;
  schedule: RetrySchedule;
  shouldRetry: (err: unknown, attempt: number) => boolean;
  /** Test seam — override the wall-clock sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    setTimeout(resolve, ms);
  });

/**
 * Run `fn` per the retry schedule. Each attempt is preceded by the
 * corresponding delay from `schedule.delays[attempt]`.
 *
 * On success: returns the result immediately.
 * On thrown error: consults `shouldRetry(err, attempt)`. If `false` OR the
 * attempt was the last, re-throws immediately. Otherwise waits the next
 * scheduled delay and retries.
 */
export async function withRetry<T>(opts: WithRetryOptions<T>): Promise<T> {
  const { fn, schedule, shouldRetry } = opts;
  const sleep = opts.sleep ?? defaultSleep;
  if (schedule.delays.length < 1) {
    throw new Error('RetrySchedule must have at least one delay entry');
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < schedule.delays.length; attempt++) {
    const delay = schedule.delays[attempt] ?? 0;
    if (delay > 0) await sleep(delay);
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const isLast = attempt === schedule.delays.length - 1;
      if (isLast) throw err;
      if (!shouldRetry(err, attempt)) throw err;
      // else continue to next attempt
    }
  }
  // Unreachable — the loop either returns or re-throws.
  throw lastError;
}
