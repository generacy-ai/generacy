import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateRetryDelay,
  calculateRetryDelayDeterministic,
  retry,
  withRetry,
  MaxRetriesExceededError,
} from '../../src/utils/retry.js';
import type { RetryConfig } from '../../src/types/config.js';

describe('calculateRetryDelayDeterministic', () => {
  const config: RetryConfig = {
    maxAttempts: 5,
    initialDelay: 1000,
    maxDelay: 16000,
    backoffFactor: 2,
  };

  it('calculates exponential delays', () => {
    expect(calculateRetryDelayDeterministic(0, config)).toBe(1000);
    expect(calculateRetryDelayDeterministic(1, config)).toBe(2000);
    expect(calculateRetryDelayDeterministic(2, config)).toBe(4000);
    expect(calculateRetryDelayDeterministic(3, config)).toBe(8000);
    expect(calculateRetryDelayDeterministic(4, config)).toBe(16000);
  });

  it('caps delay at maxDelay', () => {
    expect(calculateRetryDelayDeterministic(5, config)).toBe(16000);
    expect(calculateRetryDelayDeterministic(10, config)).toBe(16000);
  });

  it('uses default config when not provided', () => {
    const delay = calculateRetryDelayDeterministic(0);
    expect(delay).toBe(1000);
  });
});

describe('calculateRetryDelay', () => {
  const config: RetryConfig = {
    maxAttempts: 5,
    initialDelay: 1000,
    maxDelay: 16000,
    backoffFactor: 2,
  };

  it('returns delay within expected range with jitter', () => {
    const baseDelay = 1000;
    const maxJitter = baseDelay * 0.1;

    for (let i = 0; i < 100; i++) {
      const delay = calculateRetryDelay(0, config);
      expect(delay).toBeGreaterThanOrEqual(baseDelay);
      expect(delay).toBeLessThanOrEqual(baseDelay + maxJitter);
    }
  });

  it('caps delay at maxDelay even with jitter', () => {
    for (let i = 0; i < 100; i++) {
      const delay = calculateRetryDelay(10, config);
      expect(delay).toBeLessThanOrEqual(config.maxDelay);
    }
  });
});

describe('retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const resultPromise = retry({ fn, maxAttempts: 3 });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success');

    const resultPromise = retry({ fn, maxAttempts: 3, initialDelay: 100, backoffFactor: 2, maxDelay: 1000 });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws MaxRetriesExceededError when all retries fail', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));

    const resultPromise = retry({ fn, maxAttempts: 3, initialDelay: 100, backoffFactor: 2, maxDelay: 1000 });
    const assertion = expect(resultPromise).rejects.toThrow(MaxRetriesExceededError);
    await vi.runAllTimersAsync();

    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('calls onRetry callback', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('success');
    const onRetry = vi.fn();

    const resultPromise = retry({ fn, maxAttempts: 3, initialDelay: 100, backoffFactor: 2, maxDelay: 1000, onRetry });
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(0, expect.any(Error), expect.any(Number));
  });

  it('respects isRetryable predicate', async () => {
    const nonRetryableError = new Error('non-retryable');
    const fn = vi.fn().mockRejectedValue(nonRetryableError);
    const isRetryable = vi.fn().mockReturnValue(false);

    const resultPromise = retry({ fn, maxAttempts: 3, isRetryable });

    await expect(resultPromise).rejects.toThrow('non-retryable');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(isRetryable).toHaveBeenCalledWith(nonRetryableError);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('wraps function with retry logic', async () => {
    const original = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue(42);

    const wrapped = withRetry(original, { maxAttempts: 3, initialDelay: 100, backoffFactor: 2, maxDelay: 1000 });

    const resultPromise = wrapped();
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe(42);
    expect(original).toHaveBeenCalledTimes(2);
  });

  it('passes arguments to wrapped function', async () => {
    const original = vi.fn().mockResolvedValue('result');
    const wrapped = withRetry(original);

    const resultPromise = wrapped('arg1', 'arg2');
    await vi.runAllTimersAsync();
    await resultPromise;

    expect(original).toHaveBeenCalledWith('arg1', 'arg2');
  });
});
