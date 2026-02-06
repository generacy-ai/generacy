/**
 * Unit tests for retry logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateDelay,
  withRetry,
  createRetryWrapper,
  isRetryableStatusCode,
  shouldRetryError,
  sleep,
} from '../../src/utils/retry.js';
import { CloudBuildError, RateLimitError, NotFoundError } from '../../src/errors.js';

describe('calculateDelay', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should calculate exponential backoff', () => {
    const delay0 = calculateDelay(0, 1000, 30000);
    const delay1 = calculateDelay(1, 1000, 30000);
    const delay2 = calculateDelay(2, 1000, 30000);

    // With random = 0.5, jitter = 0.8 + 0.5 * 0.4 = 1.0
    expect(delay0).toBe(1000); // 1000 * 2^0 * 1.0
    expect(delay1).toBe(2000); // 1000 * 2^1 * 1.0
    expect(delay2).toBe(4000); // 1000 * 2^2 * 1.0
  });

  it('should cap at maxDelay', () => {
    const delay = calculateDelay(10, 1000, 30000);

    // 1000 * 2^10 = 1024000, capped at 30000
    expect(delay).toBe(30000);
  });

  it('should apply jitter to delays', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.0);
    const delayMin = calculateDelay(0, 1000, 30000);

    vi.spyOn(Math, 'random').mockReturnValue(1.0);
    const delayMax = calculateDelay(0, 1000, 30000);

    // Jitter range: 0.8 to 1.2
    expect(delayMin).toBe(800);  // 1000 * 0.8
    expect(delayMax).toBe(1200); // 1000 * 1.2
  });
});

describe('sleep', () => {
  it('should resolve after specified duration', async () => {
    vi.useFakeTimers();

    const promise = sleep(1000);
    vi.advanceTimersByTime(1000);
    await promise;

    vi.useRealTimers();
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const resultPromise = withRetry(fn, { maxAttempts: 3 });
    const result = await resultPromise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on transient error', async () => {
    const transientError = new RateLimitError('Rate limited');
    const fn = vi.fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce('success');

    const resultPromise = withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000,
    });

    // Advance time to trigger retry
    await vi.advanceTimersByTimeAsync(200);

    const result = await resultPromise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should not retry on non-transient error', async () => {
    const nonTransientError = new NotFoundError('Build', 'build-123');
    const fn = vi.fn().mockRejectedValue(nonTransientError);

    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow(NotFoundError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should throw after max attempts', async () => {
    vi.useRealTimers(); // Use real timers for this test

    const transientError = new RateLimitError('Rate limited');
    const fn = vi.fn().mockRejectedValue(transientError);

    await expect(withRetry(fn, {
      maxAttempts: 2,
      initialDelayMs: 1, // Use very small delays for fast test
      maxDelayMs: 5,
    })).rejects.toThrow(RateLimitError);

    expect(fn).toHaveBeenCalledTimes(2);

    vi.useFakeTimers(); // Restore fake timers
  });

  it('should call onRetry callback', async () => {
    const transientError = new RateLimitError('Rate limited');
    const fn = vi.fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce('success');
    const onRetry = vi.fn();

    const resultPromise = withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      onRetry,
    });

    await vi.advanceTimersByTimeAsync(200);
    await resultPromise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(transientError, 1, expect.any(Number));
  });

  it('should use custom shouldRetry function', async () => {
    const customError = new Error('Custom error');
    const fn = vi.fn()
      .mockRejectedValueOnce(customError)
      .mockResolvedValueOnce('success');

    const resultPromise = withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      maxDelayMs: 1000,
      shouldRetry: (err) => err instanceof Error && err.message === 'Custom error',
    });

    await vi.advanceTimersByTimeAsync(200);
    const result = await resultPromise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('createRetryWrapper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should create a reusable retry wrapper', async () => {
    const wrapper = createRetryWrapper({
      maxAttempts: 2,
      initialDelayMs: 100,
      maxDelayMs: 1000,
    });

    const fn = vi.fn().mockResolvedValue('result');
    const result = await wrapper(fn);

    expect(result).toBe('result');
  });
});

describe('isRetryableStatusCode', () => {
  it('should return true for retryable status codes', () => {
    expect(isRetryableStatusCode(408)).toBe(true);
    expect(isRetryableStatusCode(429)).toBe(true);
    expect(isRetryableStatusCode(500)).toBe(true);
    expect(isRetryableStatusCode(502)).toBe(true);
    expect(isRetryableStatusCode(503)).toBe(true);
    expect(isRetryableStatusCode(504)).toBe(true);
  });

  it('should return false for non-retryable status codes', () => {
    expect(isRetryableStatusCode(400)).toBe(false);
    expect(isRetryableStatusCode(401)).toBe(false);
    expect(isRetryableStatusCode(403)).toBe(false);
    expect(isRetryableStatusCode(404)).toBe(false);
    expect(isRetryableStatusCode(200)).toBe(false);
  });
});

describe('shouldRetryError', () => {
  it('should return true for transient CloudBuildError', () => {
    const error = new RateLimitError('Rate limited');
    expect(shouldRetryError(error)).toBe(true);
  });

  it('should return false for non-transient CloudBuildError', () => {
    const error = new NotFoundError('Build', 'build-123');
    expect(shouldRetryError(error)).toBe(false);
  });

  it('should check status code in error object', () => {
    const retryableError = { code: 503 };
    const nonRetryableError = { code: 404 };

    expect(shouldRetryError(retryableError)).toBe(true);
    expect(shouldRetryError(nonRetryableError)).toBe(false);
  });

  it('should return false for unknown errors', () => {
    expect(shouldRetryError(new Error('Unknown'))).toBe(false);
    expect(shouldRetryError('string error')).toBe(false);
    expect(shouldRetryError(null)).toBe(false);
  });
});
