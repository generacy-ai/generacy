/**
 * Tests for `withRetry` + `QUERY_RETRY_SCHEDULE` (#1038 T034).
 *
 * The schedule is a compile-time constant (Q3 → D locks number + budget).
 * These tests pin: exact attempt count, delay ordering, shouldRetry short-
 * circuit, success short-circuit, total budget, and frozen-ness.
 */
import { describe, it, expect, vi } from 'vitest';
import { QUERY_RETRY_SCHEDULE, withRetry } from '../retry.js';

function makeSleep(): {
  sleep: (ms: number) => Promise<void>;
  calls: number[];
} {
  const calls: number[] = [];
  return {
    sleep: async (ms: number) => {
      calls.push(ms);
    },
    calls,
  };
}

describe('QUERY_RETRY_SCHEDULE — locked shape', () => {
  it('exactly 3 attempts (initial + 2 retries)', () => {
    expect(QUERY_RETRY_SCHEDULE.delays).toHaveLength(3);
  });

  it('delays are 0 / 1500 / 3500 ms (Q3 → D)', () => {
    expect([...QUERY_RETRY_SCHEDULE.delays]).toEqual([0, 1500, 3500]);
  });

  it('total wall-clock budget is exactly 5000 ms', () => {
    const total = [...QUERY_RETRY_SCHEDULE.delays].reduce((s, v) => s + v, 0);
    expect(total).toBe(5000);
  });

  it('is frozen — mutation attempts throw', () => {
    expect(Object.isFrozen(QUERY_RETRY_SCHEDULE)).toBe(true);
    expect(Object.isFrozen(QUERY_RETRY_SCHEDULE.delays)).toBe(true);
    expect(() => {
      (QUERY_RETRY_SCHEDULE.delays as unknown as number[])[0] = 999;
    }).toThrow();
  });
});

describe('withRetry', () => {
  it('success on first attempt → single fn call, no sleeps beyond the initial 0', async () => {
    const { sleep, calls } = makeSleep();
    const fn = vi.fn(async () => 'ok');
    const result = await withRetry({
      fn,
      schedule: { delays: [0, 1500, 3500] },
      shouldRetry: () => true,
      sleep,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    // delay=0 is skipped (no positive delay to sleep), so no sleep calls.
    expect(calls).toEqual([]);
  });

  it('fires exactly schedule.delays.length attempts on persistent failure', async () => {
    const { sleep } = makeSleep();
    const fn = vi.fn(async () => {
      throw new Error('always');
    });
    await expect(
      withRetry({
        fn,
        schedule: QUERY_RETRY_SCHEDULE,
        shouldRetry: () => true,
        sleep,
      }),
    ).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('honors delays in order (with sleep seam)', async () => {
    const { sleep, calls } = makeSleep();
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    await withRetry({
      fn,
      schedule: QUERY_RETRY_SCHEDULE,
      shouldRetry: () => true,
      sleep,
    }).catch(() => {});
    // First attempt: delay=0 skipped. Retries: 1500 then 3500.
    expect(calls).toEqual([1500, 3500]);
  });

  it('shouldRetry === false short-circuits regardless of remaining attempts', async () => {
    const { sleep } = makeSleep();
    const fn = vi.fn(async () => {
      throw new Error('terminal');
    });
    const shouldRetry = vi.fn(() => false);
    await expect(
      withRetry({
        fn,
        schedule: QUERY_RETRY_SCHEDULE,
        shouldRetry,
        sleep,
      }),
    ).rejects.toThrow('terminal');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledTimes(1);
  });

  it('success on attempt N short-circuits (no further attempts, correct delays)', async () => {
    const { sleep, calls } = makeSleep();
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 2) throw new Error('transient');
      return 'ok';
    });
    const result = await withRetry({
      fn,
      schedule: QUERY_RETRY_SCHEDULE,
      shouldRetry: () => true,
      sleep,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    // Delay: 1500ms slept before attempt 2. No 3500ms sleep since attempt 2 succeeded.
    expect(calls).toEqual([1500]);
  });

  it('shouldRetry receives the error and attempt index', async () => {
    const { sleep } = makeSleep();
    const errors: unknown[] = [];
    const attempts: number[] = [];
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    const shouldRetry = (err: unknown, attempt: number) => {
      errors.push(err);
      attempts.push(attempt);
      return true;
    };
    await withRetry({
      fn,
      schedule: QUERY_RETRY_SCHEDULE,
      shouldRetry,
      sleep,
    }).catch(() => {});
    // shouldRetry is consulted between attempts (not after the LAST attempt).
    expect(attempts).toEqual([0, 1]);
    expect(errors.every((e) => e instanceof Error)).toBe(true);
  });
});
