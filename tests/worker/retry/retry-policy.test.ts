/**
 * Tests for retry policies used by the worker service.
 *
 * These policies provide different retry strategies for job handlers:
 * - ExponentialBackoffPolicy: Retries with exponential backoff for agent errors
 * - NoRetryPolicy: No retry, execute once
 * - StatusCodeRetryPolicy: Retries based on HTTP status codes for integrations
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  AgentRetryConfig,
  IntegrationRetryConfig,
} from '../../../src/worker/types.js';

// ============ Types ============

/**
 * Retry policy interface - all policies implement this
 */
interface RetryPolicy {
  execute<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Error with a code property for retryable error detection
 */
interface CodedError extends Error {
  code: string;
}

/**
 * HTTP error with status code for integration retries
 */
interface HttpError extends Error {
  statusCode: number;
}

// ============ Policy Implementations (to be created) ============

/**
 * Exponential backoff retry policy for agent jobs.
 * Retries on specific error codes with exponentially increasing delays.
 */
class ExponentialBackoffPolicy implements RetryPolicy {
  constructor(private config: AgentRetryConfig) {}

  /**
   * Check if an error is retryable based on its code
   */
  isRetryable(error: unknown): boolean {
    if (
      error instanceof Error &&
      'code' in error &&
      typeof (error as CodedError).code === 'string'
    ) {
      return this.config.retryableErrors.includes((error as CodedError).code);
    }
    return false;
  }

  /**
   * Calculate delay for a given attempt using exponential backoff
   */
  private calculateDelay(attempt: number): number {
    const delay =
      this.config.initialDelay *
      Math.pow(this.config.backoffMultiplier, attempt);
    return Math.min(delay, this.config.maxDelay);
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.isRetryable(error) || attempt >= this.config.maxRetries) {
          throw lastError;
        }

        const delay = this.calculateDelay(attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}

/**
 * No-retry policy - executes the function once without any retry logic.
 */
class NoRetryPolicy implements RetryPolicy {
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

/**
 * Status code based retry policy for integration jobs.
 * Retries on specific HTTP status codes with fixed delay.
 */
class StatusCodeRetryPolicy implements RetryPolicy {
  constructor(private config: IntegrationRetryConfig) {}

  /**
   * Check if an error should trigger a retry based on status code
   */
  isRetryable(error: unknown): boolean {
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof (error as HttpError).statusCode === 'number'
    ) {
      return this.config.retryOn.includes((error as HttpError).statusCode);
    }
    return false;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.isRetryable(error) || attempt >= this.config.maxRetries) {
          throw lastError;
        }

        await new Promise(resolve =>
          setTimeout(resolve, this.config.retryDelay)
        );
      }
    }

    throw lastError;
  }
}

// ============ Test Helpers ============

/**
 * Create an error with a code property
 */
function createCodedError(message: string, code: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

/**
 * Create an HTTP error with a status code
 */
function createHttpError(message: string, statusCode: number): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

// ============ Tests ============

describe('ExponentialBackoffPolicy', () => {
  const defaultConfig: AgentRetryConfig = {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffMultiplier: 2,
    retryableErrors: ['RATE_LIMIT', 'TIMEOUT', 'NETWORK_ERROR'],
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('successful execution on first try', () => {
    it('returns the result immediately without delay', async () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);
      const fn = vi.fn().mockResolvedValue('success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('returns complex objects', async () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);
      const expectedResult = { data: [1, 2, 3], status: 'ok' };
      const fn = vi.fn().mockResolvedValue(expectedResult);

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual(expectedResult);
    });
  });

  describe('retry on retryable error with correct delay', () => {
    it('retries on RATE_LIMIT error', async () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createCodedError('Rate limited', 'RATE_LIMIT'))
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries on TIMEOUT error', async () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createCodedError('Timed out', 'TIMEOUT'))
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries on NETWORK_ERROR', async () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);
      const fn = vi
        .fn()
        .mockRejectedValueOnce(
          createCodedError('Network failed', 'NETWORK_ERROR')
        )
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('waits the correct initial delay before first retry', async () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createCodedError('Rate limited', 'RATE_LIMIT'))
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);

      // After initial call, should not have retried yet
      expect(fn).toHaveBeenCalledTimes(1);

      // Advance past initial delay
      await vi.advanceTimersByTimeAsync(1000);

      await vi.runAllTimersAsync();
      await resultPromise;

      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('exponential backoff calculation', () => {
    it('doubles delay on each subsequent retry', async () => {
      const config: AgentRetryConfig = {
        ...defaultConfig,
        maxRetries: 4,
        initialDelay: 100,
        maxDelay: 10000,
        backoffMultiplier: 2,
      };
      const policy = new ExponentialBackoffPolicy(config);
      const delays: number[] = [];

      const fn = vi
        .fn()
        .mockRejectedValueOnce(createCodedError('Error', 'RATE_LIMIT'))
        .mockRejectedValueOnce(createCodedError('Error', 'RATE_LIMIT'))
        .mockRejectedValueOnce(createCodedError('Error', 'RATE_LIMIT'))
        .mockResolvedValue('success');

      const startTime = Date.now();
      const resultPromise = policy.execute(fn);

      // First attempt happens immediately
      expect(fn).toHaveBeenCalledTimes(1);

      // Wait for first retry (100ms)
      await vi.advanceTimersByTimeAsync(100);
      delays.push(Date.now() - startTime);
      expect(fn).toHaveBeenCalledTimes(2);

      // Wait for second retry (200ms)
      await vi.advanceTimersByTimeAsync(200);
      delays.push(Date.now() - startTime);
      expect(fn).toHaveBeenCalledTimes(3);

      // Wait for third retry (400ms)
      await vi.advanceTimersByTimeAsync(400);
      delays.push(Date.now() - startTime);
      expect(fn).toHaveBeenCalledTimes(4);

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      // Delays should follow pattern: 100, 300 (100+200), 700 (100+200+400)
      expect(delays[0]).toBe(100);
      expect(delays[1]).toBe(300);
      expect(delays[2]).toBe(700);
    });

    it('uses custom backoff multiplier', async () => {
      const config: AgentRetryConfig = {
        ...defaultConfig,
        maxRetries: 3,
        initialDelay: 100,
        maxDelay: 10000,
        backoffMultiplier: 3, // Triple each time
      };
      const policy = new ExponentialBackoffPolicy(config);

      const fn = vi
        .fn()
        .mockRejectedValueOnce(createCodedError('Error', 'RATE_LIMIT'))
        .mockRejectedValueOnce(createCodedError('Error', 'RATE_LIMIT'))
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);

      // First attempt
      expect(fn).toHaveBeenCalledTimes(1);

      // Wait 100ms for first retry
      await vi.advanceTimersByTimeAsync(100);
      expect(fn).toHaveBeenCalledTimes(2);

      // Wait 300ms (100 * 3^1) for second retry
      await vi.advanceTimersByTimeAsync(300);
      expect(fn).toHaveBeenCalledTimes(3);

      await vi.runAllTimersAsync();
      await resultPromise;
    });
  });

  describe('max delay cap', () => {
    it('caps delay at maxDelay', async () => {
      const config: AgentRetryConfig = {
        ...defaultConfig,
        maxRetries: 5,
        initialDelay: 1000,
        maxDelay: 5000,
        backoffMultiplier: 4, // Would be 1000, 4000, 16000, 64000... but capped at 5000
      };
      const policy = new ExponentialBackoffPolicy(config);

      const fn = vi
        .fn()
        .mockRejectedValueOnce(createCodedError('Error', 'RATE_LIMIT'))
        .mockRejectedValueOnce(createCodedError('Error', 'RATE_LIMIT'))
        .mockRejectedValueOnce(createCodedError('Error', 'RATE_LIMIT'))
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);

      // First attempt
      expect(fn).toHaveBeenCalledTimes(1);

      // Wait 1000ms for first retry
      await vi.advanceTimersByTimeAsync(1000);
      expect(fn).toHaveBeenCalledTimes(2);

      // Wait 4000ms for second retry
      await vi.advanceTimersByTimeAsync(4000);
      expect(fn).toHaveBeenCalledTimes(3);

      // Third retry would be 16000ms but capped at 5000ms
      await vi.advanceTimersByTimeAsync(5000);
      expect(fn).toHaveBeenCalledTimes(4);

      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result).toBe('success');
    });

    it('applies cap from first retry if initialDelay exceeds maxDelay', async () => {
      const config: AgentRetryConfig = {
        ...defaultConfig,
        maxRetries: 2,
        initialDelay: 10000,
        maxDelay: 5000,
        backoffMultiplier: 2,
      };
      const policy = new ExponentialBackoffPolicy(config);

      const fn = vi
        .fn()
        .mockRejectedValueOnce(createCodedError('Error', 'RATE_LIMIT'))
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);

      expect(fn).toHaveBeenCalledTimes(1);

      // Should wait maxDelay (5000), not initialDelay (10000)
      await vi.advanceTimersByTimeAsync(5000);
      expect(fn).toHaveBeenCalledTimes(2);

      await vi.runAllTimersAsync();
      await resultPromise;
    });
  });

  describe('max retries limit', () => {
    it('stops after maxRetries and throws last error', async () => {
      const config: AgentRetryConfig = {
        ...defaultConfig,
        maxRetries: 2,
        initialDelay: 100,
      };
      const policy = new ExponentialBackoffPolicy(config);

      const fn = vi.fn().mockRejectedValue(createCodedError('Always fails', 'RATE_LIMIT'));

      const resultPromise = policy.execute(fn);
      const assertion = expect(resultPromise).rejects.toThrow('Always fails');
      await vi.runAllTimersAsync();

      await assertion;
      // Initial attempt + 2 retries = 3 total calls
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('respects maxRetries of 0 (no retries)', async () => {
      const config: AgentRetryConfig = {
        ...defaultConfig,
        maxRetries: 0,
      };
      const policy = new ExponentialBackoffPolicy(config);

      const fn = vi.fn().mockRejectedValue(createCodedError('Fails', 'RATE_LIMIT'));

      await expect(policy.execute(fn)).rejects.toThrow('Fails');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('succeeds on last retry attempt', async () => {
      const config: AgentRetryConfig = {
        ...defaultConfig,
        maxRetries: 2,
        initialDelay: 100,
      };
      const policy = new ExponentialBackoffPolicy(config);

      const fn = vi
        .fn()
        .mockRejectedValueOnce(createCodedError('Fail 1', 'RATE_LIMIT'))
        .mockRejectedValueOnce(createCodedError('Fail 2', 'RATE_LIMIT'))
        .mockResolvedValue('finally success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('finally success');
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('non-retryable errors thrown immediately', () => {
    it('throws immediately for non-retryable error codes', async () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);
      const fn = vi.fn().mockRejectedValue(createCodedError('Unknown error', 'UNKNOWN_ERROR'));

      await expect(policy.execute(fn)).rejects.toThrow('Unknown error');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws immediately for errors without code property', async () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);
      const fn = vi.fn().mockRejectedValue(new Error('Plain error'));

      await expect(policy.execute(fn)).rejects.toThrow('Plain error');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws immediately for non-Error objects', async () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);
      const fn = vi.fn().mockRejectedValue('string error');

      await expect(policy.execute(fn)).rejects.toThrow('string error');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('distinguishes between retryable and non-retryable in sequence', async () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createCodedError('Retry this', 'RATE_LIMIT'))
        .mockRejectedValueOnce(createCodedError('Do not retry', 'FATAL_ERROR'));

      const resultPromise = policy.execute(fn);
      const assertion = expect(resultPromise).rejects.toThrow('Do not retry');
      await vi.runAllTimersAsync();

      await assertion;
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('isRetryable method', () => {
    it('returns true for configured error codes', () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);

      expect(policy.isRetryable(createCodedError('', 'RATE_LIMIT'))).toBe(true);
      expect(policy.isRetryable(createCodedError('', 'TIMEOUT'))).toBe(true);
      expect(policy.isRetryable(createCodedError('', 'NETWORK_ERROR'))).toBe(true);
    });

    it('returns false for non-configured error codes', () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);

      expect(policy.isRetryable(createCodedError('', 'UNKNOWN'))).toBe(false);
      expect(policy.isRetryable(createCodedError('', 'FATAL'))).toBe(false);
    });

    it('returns false for plain errors without code', () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);

      expect(policy.isRetryable(new Error('plain error'))).toBe(false);
    });

    it('returns false for non-error values', () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);

      expect(policy.isRetryable('string')).toBe(false);
      expect(policy.isRetryable(null)).toBe(false);
      expect(policy.isRetryable(undefined)).toBe(false);
      expect(policy.isRetryable(123)).toBe(false);
      expect(policy.isRetryable({ code: 'RATE_LIMIT' })).toBe(false); // Not an Error instance
    });

    it('is case-sensitive for error codes', () => {
      const policy = new ExponentialBackoffPolicy(defaultConfig);

      expect(policy.isRetryable(createCodedError('', 'RATE_LIMIT'))).toBe(true);
      expect(policy.isRetryable(createCodedError('', 'rate_limit'))).toBe(false);
      expect(policy.isRetryable(createCodedError('', 'Rate_Limit'))).toBe(false);
    });
  });
});

describe('NoRetryPolicy', () => {
  describe('successful execution', () => {
    it('returns the result from successful function', async () => {
      const policy = new NoRetryPolicy();
      const fn = vi.fn().mockResolvedValue('success');

      const result = await policy.execute(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('returns complex objects', async () => {
      const policy = new NoRetryPolicy();
      const expectedResult = { nested: { data: [1, 2, 3] } };
      const fn = vi.fn().mockResolvedValue(expectedResult);

      const result = await policy.execute(fn);

      expect(result).toEqual(expectedResult);
    });

    it('returns null and undefined values', async () => {
      const policy = new NoRetryPolicy();

      const nullFn = vi.fn().mockResolvedValue(null);
      const undefinedFn = vi.fn().mockResolvedValue(undefined);

      expect(await policy.execute(nullFn)).toBeNull();
      expect(await policy.execute(undefinedFn)).toBeUndefined();
    });
  });

  describe('error thrown immediately', () => {
    it('throws error without retrying', async () => {
      const policy = new NoRetryPolicy();
      const fn = vi.fn().mockRejectedValue(new Error('Immediate failure'));

      await expect(policy.execute(fn)).rejects.toThrow('Immediate failure');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws coded errors without retrying', async () => {
      const policy = new NoRetryPolicy();
      const fn = vi.fn().mockRejectedValue(createCodedError('Rate limited', 'RATE_LIMIT'));

      await expect(policy.execute(fn)).rejects.toThrow('Rate limited');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws HTTP errors without retrying', async () => {
      const policy = new NoRetryPolicy();
      const fn = vi.fn().mockRejectedValue(createHttpError('Server error', 500));

      await expect(policy.execute(fn)).rejects.toThrow('Server error');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('preserves error type', async () => {
      const policy = new NoRetryPolicy();
      const error = createCodedError('Test', 'TEST_CODE');
      const fn = vi.fn().mockRejectedValue(error);

      try {
        await policy.execute(fn);
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBe(error);
        expect((e as CodedError).code).toBe('TEST_CODE');
      }
    });
  });
});

describe('StatusCodeRetryPolicy', () => {
  const defaultConfig: IntegrationRetryConfig = {
    maxRetries: 3,
    retryDelay: 1000,
    retryOn: [429, 500, 502, 503, 504],
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('successful execution on first try', () => {
    it('returns the result immediately', async () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);
      const fn = vi.fn().mockResolvedValue({ status: 200, data: 'ok' });

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual({ status: 200, data: 'ok' });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry on configured status codes', () => {
    it('retries on 429 Too Many Requests', async () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createHttpError('Rate limited', 429))
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries on 500 Internal Server Error', async () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createHttpError('Server error', 500))
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries on 502 Bad Gateway', async () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createHttpError('Bad gateway', 502))
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries on 503 Service Unavailable', async () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createHttpError('Service unavailable', 503))
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('retries on 504 Gateway Timeout', async () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createHttpError('Gateway timeout', 504))
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('uses fixed delay between retries', async () => {
      const config: IntegrationRetryConfig = {
        maxRetries: 3,
        retryDelay: 500,
        retryOn: [500],
      };
      const policy = new StatusCodeRetryPolicy(config);

      const fn = vi
        .fn()
        .mockRejectedValueOnce(createHttpError('Error', 500))
        .mockRejectedValueOnce(createHttpError('Error', 500))
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);

      expect(fn).toHaveBeenCalledTimes(1);

      // Wait for first retry
      await vi.advanceTimersByTimeAsync(500);
      expect(fn).toHaveBeenCalledTimes(2);

      // Wait for second retry (same delay, not exponential)
      await vi.advanceTimersByTimeAsync(500);
      expect(fn).toHaveBeenCalledTimes(3);

      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result).toBe('success');
    });
  });

  describe('no retry on other status codes', () => {
    it('throws immediately on 400 Bad Request', async () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);
      const fn = vi.fn().mockRejectedValue(createHttpError('Bad request', 400));

      await expect(policy.execute(fn)).rejects.toThrow('Bad request');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws immediately on 401 Unauthorized', async () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);
      const fn = vi.fn().mockRejectedValue(createHttpError('Unauthorized', 401));

      await expect(policy.execute(fn)).rejects.toThrow('Unauthorized');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws immediately on 403 Forbidden', async () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);
      const fn = vi.fn().mockRejectedValue(createHttpError('Forbidden', 403));

      await expect(policy.execute(fn)).rejects.toThrow('Forbidden');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws immediately on 404 Not Found', async () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);
      const fn = vi.fn().mockRejectedValue(createHttpError('Not found', 404));

      await expect(policy.execute(fn)).rejects.toThrow('Not found');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws immediately on 422 Unprocessable Entity', async () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);
      const fn = vi.fn().mockRejectedValue(createHttpError('Validation error', 422));

      await expect(policy.execute(fn)).rejects.toThrow('Validation error');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws immediately for errors without statusCode', async () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);
      const fn = vi.fn().mockRejectedValue(new Error('Plain error'));

      await expect(policy.execute(fn)).rejects.toThrow('Plain error');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('max retries limit', () => {
    it('stops after maxRetries and throws last error', async () => {
      const config: IntegrationRetryConfig = {
        maxRetries: 2,
        retryDelay: 100,
        retryOn: [500],
      };
      const policy = new StatusCodeRetryPolicy(config);

      const fn = vi.fn().mockRejectedValue(createHttpError('Always fails', 500));

      const resultPromise = policy.execute(fn);
      const assertion = expect(resultPromise).rejects.toThrow('Always fails');
      await vi.runAllTimersAsync();

      await assertion;
      // Initial attempt + 2 retries = 3 total calls
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('respects maxRetries of 0', async () => {
      const config: IntegrationRetryConfig = {
        maxRetries: 0,
        retryDelay: 100,
        retryOn: [500],
      };
      const policy = new StatusCodeRetryPolicy(config);

      const fn = vi.fn().mockRejectedValue(createHttpError('Fails', 500));

      // maxRetries=0 means no retry, so it throws immediately (non-retryable path)
      await expect(policy.execute(fn)).rejects.toThrow('Fails');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('succeeds on last retry attempt', async () => {
      const config: IntegrationRetryConfig = {
        maxRetries: 2,
        retryDelay: 100,
        retryOn: [500],
      };
      const policy = new StatusCodeRetryPolicy(config);

      const fn = vi
        .fn()
        .mockRejectedValueOnce(createHttpError('Fail 1', 500))
        .mockRejectedValueOnce(createHttpError('Fail 2', 500))
        .mockResolvedValue('finally success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('finally success');
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('custom configuration', () => {
    it('uses custom retryOn array', async () => {
      const config: IntegrationRetryConfig = {
        maxRetries: 1,
        retryDelay: 100,
        retryOn: [418], // I'm a teapot!
      };
      const policy = new StatusCodeRetryPolicy(config);

      const fn = vi
        .fn()
        .mockRejectedValueOnce(createHttpError('Teapot', 418))
        .mockResolvedValue('success');

      const resultPromise = policy.execute(fn);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('does not retry status codes not in retryOn', async () => {
      const config: IntegrationRetryConfig = {
        maxRetries: 3,
        retryDelay: 100,
        retryOn: [500], // Only 500, not 502
      };
      const policy = new StatusCodeRetryPolicy(config);

      const fn = vi.fn().mockRejectedValue(createHttpError('Bad gateway', 502));

      await expect(policy.execute(fn)).rejects.toThrow('Bad gateway');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('handles empty retryOn array (no retries)', async () => {
      const config: IntegrationRetryConfig = {
        maxRetries: 3,
        retryDelay: 100,
        retryOn: [],
      };
      const policy = new StatusCodeRetryPolicy(config);

      const fn = vi.fn().mockRejectedValue(createHttpError('Server error', 500));

      await expect(policy.execute(fn)).rejects.toThrow('Server error');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('isRetryable method', () => {
    it('returns true for configured status codes', () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);

      expect(policy.isRetryable(createHttpError('', 429))).toBe(true);
      expect(policy.isRetryable(createHttpError('', 500))).toBe(true);
      expect(policy.isRetryable(createHttpError('', 502))).toBe(true);
      expect(policy.isRetryable(createHttpError('', 503))).toBe(true);
      expect(policy.isRetryable(createHttpError('', 504))).toBe(true);
    });

    it('returns false for non-configured status codes', () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);

      expect(policy.isRetryable(createHttpError('', 400))).toBe(false);
      expect(policy.isRetryable(createHttpError('', 401))).toBe(false);
      expect(policy.isRetryable(createHttpError('', 404))).toBe(false);
    });

    it('returns false for plain errors without statusCode', () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);

      expect(policy.isRetryable(new Error('plain error'))).toBe(false);
    });

    it('returns false for non-error values', () => {
      const policy = new StatusCodeRetryPolicy(defaultConfig);

      expect(policy.isRetryable('string')).toBe(false);
      expect(policy.isRetryable(null)).toBe(false);
      expect(policy.isRetryable(undefined)).toBe(false);
      expect(policy.isRetryable({ statusCode: 500 })).toBe(false); // Not an Error instance
    });
  });
});

describe('RetryPolicy interface compliance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const policies: Array<{ name: string; policy: RetryPolicy }> = [
    {
      name: 'ExponentialBackoffPolicy',
      policy: new ExponentialBackoffPolicy({
        maxRetries: 1,
        initialDelay: 100,
        maxDelay: 1000,
        backoffMultiplier: 2,
        retryableErrors: ['RETRY'],
      }),
    },
    {
      name: 'NoRetryPolicy',
      policy: new NoRetryPolicy(),
    },
    {
      name: 'StatusCodeRetryPolicy',
      policy: new StatusCodeRetryPolicy({
        maxRetries: 1,
        retryDelay: 100,
        retryOn: [500],
      }),
    },
  ];

  for (const { name, policy } of policies) {
    describe(name, () => {
      it('implements execute method returning Promise', async () => {
        const fn = vi.fn().mockResolvedValue('result');
        const resultPromise = policy.execute(fn);

        expect(resultPromise).toBeInstanceOf(Promise);

        await vi.runAllTimersAsync();
        const result = await resultPromise;
        expect(result).toBe('result');
      });

      it('correctly types generic return value', async () => {
        interface CustomResult {
          id: number;
          name: string;
        }

        const fn = vi.fn().mockResolvedValue({ id: 1, name: 'test' });
        const resultPromise = policy.execute<CustomResult>(fn);

        await vi.runAllTimersAsync();
        const result = await resultPromise;

        expect(result.id).toBe(1);
        expect(result.name).toBe('test');
      });

      it('propagates rejection on non-retryable error', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('Unretryable'));
        const resultPromise = policy.execute(fn);
        const assertion = expect(resultPromise).rejects.toThrow('Unretryable');

        await vi.runAllTimersAsync();

        await assertion;
      });
    });
  }
});
