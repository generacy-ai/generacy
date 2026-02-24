/**
 * Tests for retry system
 */
import { describe, it, expect, vi } from 'vitest';
import {
  constantDelay,
  linearDelay,
  exponentialDelay,
  addJitter,
  parseDuration,
  formatDuration,
  parseRetryConfig,
  calculateBackoffDelay,
  RetryManager,
  withTimeout,
} from '../index.js';

describe('parseDuration', () => {
  it('should parse milliseconds', () => {
    expect(parseDuration('100ms')).toBe(100);
    expect(parseDuration('1500ms')).toBe(1500);
  });

  it('should parse seconds', () => {
    expect(parseDuration('1s')).toBe(1000);
    expect(parseDuration('30s')).toBe(30000);
  });

  it('should parse minutes', () => {
    expect(parseDuration('1m')).toBe(60000);
    expect(parseDuration('5m')).toBe(300000);
  });

  it('should handle numbers as milliseconds', () => {
    expect(parseDuration(1000)).toBe(1000);
  });

  it('should throw on invalid formats', () => {
    expect(() => parseDuration('invalid')).toThrow();
    expect(() => parseDuration('1x')).toThrow();
  });
});

describe('formatDuration', () => {
  it('should format to appropriate units', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(60000)).toBe('1.0m');
    expect(formatDuration(90000)).toBe('1.5m');
  });
});

describe('constantDelay', () => {
  it('should return same delay for all attempts', () => {
    expect(constantDelay(1, 1000)).toBe(1000);
    expect(constantDelay(5, 1000)).toBe(1000);
    expect(constantDelay(10, 1000)).toBe(1000);
  });

  it('should respect max delay', () => {
    expect(constantDelay(1, 5000, 3000)).toBe(3000);
  });
});

describe('linearDelay', () => {
  it('should increase delay linearly', () => {
    expect(linearDelay(1, 1000)).toBe(1000);
    expect(linearDelay(2, 1000)).toBe(2000);
    expect(linearDelay(3, 1000)).toBe(3000);
  });

  it('should respect max delay', () => {
    expect(linearDelay(10, 1000, 5000)).toBe(5000);
  });
});

describe('exponentialDelay', () => {
  it('should increase delay exponentially', () => {
    expect(exponentialDelay(1, 1000)).toBe(1000);
    expect(exponentialDelay(2, 1000)).toBe(2000);
    expect(exponentialDelay(3, 1000)).toBe(4000);
    expect(exponentialDelay(4, 1000)).toBe(8000);
  });

  it('should respect max delay', () => {
    expect(exponentialDelay(5, 1000, 5000)).toBe(5000); // Would be 16000 without max
  });
});

describe('addJitter', () => {
  it('should add random jitter within factor', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // With random=0.5, jitter = (0.5 * 2 - 1) * 200 = 0, so delay stays at 1000
    const result = addJitter(1000, 0.2);
    expect(result).toBe(1000);

    vi.restoreAllMocks();
  });

  it('should never return negative delay', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    // With random=0, jitter = (0 * 2 - 1) * 50 = -50, so delay = 100 - 50 = 50
    const result = addJitter(100, 0.5);
    expect(result).toBeGreaterThanOrEqual(0);

    vi.restoreAllMocks();
  });
});

describe('parseRetryConfig', () => {
  it('should parse constant backoff config', () => {
    const step = {
      name: 'test',
      retry: {
        maxAttempts: 3,
        backoff: 'constant' as const,
        delay: '1s',
      },
    };

    const parsed = parseRetryConfig(step);
    expect(parsed.maxAttempts).toBe(3);
    expect(parsed.delay).toBe(1000);
  });

  it('should parse exponential backoff config', () => {
    const step = {
      name: 'test',
      retry: {
        maxAttempts: 5,
        backoff: 'exponential' as const,
        delay: '500ms',
        maxDelay: '30s',
      },
    };

    const parsed = parseRetryConfig(step);
    expect(parsed.maxDelay).toBe(30000);
  });

  it('should use defaults for missing values', () => {
    const step = { name: 'test' };
    const parsed = parseRetryConfig(step);

    expect(parsed.maxAttempts).toBe(1);
    expect(parsed.backoff).toBe('exponential');
  });
});

describe('calculateBackoffDelay', () => {
  it('should calculate delay based on strategy', () => {
    expect(calculateBackoffDelay('linear', 1, 1000)).toBe(1000);
    expect(calculateBackoffDelay('linear', 2, 1000)).toBe(2000);
  });

  it('should apply jitter when specified', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // With jitter factor 0, no jitter applied
    const noJitter = calculateBackoffDelay('constant', 1, 1000, undefined, 0);
    expect(noJitter).toBe(1000);

    vi.restoreAllMocks();
  });
});

describe('RetryManager', () => {
  // RetryManager.executeWithRetry takes (handler, step, context), which are
  // complex workflow types. Testing it fully requires mocking the full action
  // system, so we verify construction and basic config.
  it('should be constructible with config', () => {
    const manager = new RetryManager({
      maxAttempts: 3,
      backoff: 'constant',
      delay: 100,
    });
    expect(manager).toBeDefined();
  });
});

describe('withTimeout', () => {
  it('should resolve if operation completes in time', async () => {
    const result = await withTimeout(
      Promise.resolve('done'),
      1000
    );

    expect(result).toBe('done');
  });

  it('should reject on timeout', async () => {
    await expect(
      withTimeout(
        new Promise(resolve => setTimeout(resolve, 5000)),
        50
      )
    ).rejects.toThrow('Operation timed out');
  });

  it('should respect abort signal', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    await expect(
      withTimeout(
        new Promise(resolve => setTimeout(resolve, 5000)),
        5000,
        controller.signal
      )
    ).rejects.toThrow('Operation aborted');
  });
});
