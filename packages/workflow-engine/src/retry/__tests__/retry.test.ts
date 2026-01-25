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
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(60000)).toBe('1m');
    expect(formatDuration(90000)).toBe('1m 30s');
  });
});

describe('constantDelay', () => {
  it('should return same delay for all attempts', () => {
    expect(constantDelay(1000)(1)).toBe(1000);
    expect(constantDelay(1000)(5)).toBe(1000);
    expect(constantDelay(1000)(10)).toBe(1000);
  });
});

describe('linearDelay', () => {
  it('should increase delay linearly', () => {
    const delay = linearDelay(1000);
    expect(delay(1)).toBe(1000);
    expect(delay(2)).toBe(2000);
    expect(delay(3)).toBe(3000);
  });
});

describe('exponentialDelay', () => {
  it('should increase delay exponentially', () => {
    const delay = exponentialDelay(1000);
    expect(delay(1)).toBe(1000);
    expect(delay(2)).toBe(2000);
    expect(delay(3)).toBe(4000);
    expect(delay(4)).toBe(8000);
  });

  it('should respect max delay', () => {
    const delay = exponentialDelay(1000, 5000);
    expect(delay(5)).toBe(5000); // Would be 16000 without max
  });
});

describe('addJitter', () => {
  it('should add random jitter within factor', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const baseDelay = constantDelay(1000);
    const jitteredDelay = addJitter(baseDelay, 0.2);

    // With random=0.5, jitter should be 0 (range is -0.2 to +0.2)
    expect(jitteredDelay(1)).toBe(1000);

    vi.restoreAllMocks();
  });

  it('should never return negative delay', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const baseDelay = constantDelay(100);
    const jitteredDelay = addJitter(baseDelay, 0.5);

    expect(jitteredDelay(1)).toBeGreaterThan(0);

    vi.restoreAllMocks();
  });
});

describe('parseRetryConfig', () => {
  it('should parse constant backoff config', () => {
    const config = {
      maxAttempts: 3,
      backoff: 'constant' as const,
      delay: '1s',
    };

    const parsed = parseRetryConfig(config);
    expect(parsed.maxAttempts).toBe(3);
    expect(parsed.delay).toBe(1000);
  });

  it('should parse exponential backoff config', () => {
    const config = {
      maxAttempts: 5,
      backoff: 'exponential' as const,
      delay: '500ms',
      maxDelay: '30s',
    };

    const parsed = parseRetryConfig(config);
    expect(parsed.maxDelay).toBe(30000);
  });

  it('should use defaults for missing values', () => {
    const config = {};
    const parsed = parseRetryConfig(config);

    expect(parsed.maxAttempts).toBe(3);
    expect(parsed.backoff).toBe('exponential');
  });
});

describe('calculateBackoffDelay', () => {
  it('should calculate delay based on strategy', () => {
    const config = {
      maxAttempts: 3,
      backoff: 'linear' as const,
      delay: 1000,
    };

    expect(calculateBackoffDelay(config, 1)).toBe(1000);
    expect(calculateBackoffDelay(config, 2)).toBe(2000);
  });
});

describe('RetryManager', () => {
  it('should succeed on first attempt', async () => {
    const manager = new RetryManager({
      maxAttempts: 3,
      backoff: 'constant',
      delay: 100,
    });

    let attempts = 0;
    const result = await manager.executeWithRetry(async () => {
      attempts++;
      return 'success';
    });

    expect(result.success).toBe(true);
    expect(result.value).toBe('success');
    expect(result.attempts).toBe(1);
    expect(attempts).toBe(1);
  });

  it('should retry on failure and eventually succeed', async () => {
    const manager = new RetryManager({
      maxAttempts: 3,
      backoff: 'constant',
      delay: 10,
    });

    let attempts = 0;
    const result = await manager.executeWithRetry(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error('Not yet');
      }
      return 'success';
    });

    expect(result.success).toBe(true);
    expect(result.value).toBe('success');
    expect(result.attempts).toBe(3);
  });

  it('should fail after max attempts', async () => {
    const manager = new RetryManager({
      maxAttempts: 2,
      backoff: 'constant',
      delay: 10,
    });

    const result = await manager.executeWithRetry(async () => {
      throw new Error('Always fails');
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.attempts).toBe(2);
  });

  it('should respect AbortSignal', async () => {
    const manager = new RetryManager({
      maxAttempts: 5,
      backoff: 'constant',
      delay: 1000,
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await manager.executeWithRetry(
      async () => {
        throw new Error('Fail');
      },
      controller.signal
    );

    expect(result.success).toBe(false);
    expect(result.attempts).toBeLessThan(5);
  });
});

describe('withTimeout', () => {
  it('should resolve if operation completes in time', async () => {
    const result = await withTimeout(
      async () => 'done',
      1000
    );

    expect(result).toBe('done');
  });

  it('should reject on timeout', async () => {
    await expect(
      withTimeout(
        async () => new Promise(resolve => setTimeout(resolve, 500)),
        50
      )
    ).rejects.toThrow('Operation timed out');
  });

  it('should accept custom timeout message', async () => {
    await expect(
      withTimeout(
        async () => new Promise(resolve => setTimeout(resolve, 500)),
        50,
        'Custom timeout message'
      )
    ).rejects.toThrow('Custom timeout message');
  });
});
