export interface BackoffOptions {
  /**
   * Base pre-jitter delay in ms. The first attempt's un-capped value is
   * exactly `base`; each subsequent attempt doubles. Consumers pass their
   * own default (both smee consumers use 5_000).
   */
  base: number;

  /**
   * Upper bound on the pre-jitter delay in ms. After the equal-jitter
   * transform, the output is bounded to [cap/2, cap] — the cap is a hard
   * ceiling on the observed delay.
   */
  cap: number;

  /**
   * Optional RNG. Defaults to `Math.random`. Callers do not pass this in
   * production — the seam exists for tests that need to pin the jitter
   * band (SC-004: variance assertions across repeated calls).
   */
  random?: () => number;
}

/**
 * Equal-jitter exponential backoff.
 *
 * `raw = base * 2^attempt`; `capped = min(raw, cap)`; returns
 * `capped/2 + rng() * (capped/2)`, bounded to `[capped/2, capped)`.
 */
export function calculateBackoffDelay(
  attempt: number,
  opts: BackoffOptions,
): number {
  if (opts.base <= 0) {
    throw new RangeError('base must be > 0');
  }
  if (opts.cap < opts.base) {
    throw new RangeError('cap must be >= base');
  }
  if (!Number.isFinite(attempt) || attempt < 0) {
    throw new RangeError('attempt must be a non-negative finite number');
  }
  const rng = opts.random ?? Math.random;
  const raw = opts.base * Math.pow(2, attempt);
  const capped = Math.min(raw, opts.cap);
  return capped / 2 + rng() * (capped / 2);
}
