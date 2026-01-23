/**
 * Tests for retry logic and backoff calculations
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  constantDelay,
  linearDelay,
  exponentialDelay,
  addJitter,
  calculateBackoffDelay,
  parseDuration,
  formatDuration,
  RetryManager,
  withTimeout,
  parseRetryConfig,
} from '../index';
import type { WorkflowStep } from '../../types';
import type { ActionHandler, ActionContext, ActionResult } from '../../actions/types';

describe('Backoff Strategies', () => {
  describe('constantDelay', () => {
    it('should return the same delay for any attempt', () => {
      expect(constantDelay(1, 1000)).toBe(1000);
      expect(constantDelay(2, 1000)).toBe(1000);
      expect(constantDelay(5, 1000)).toBe(1000);
    });

    it('should respect maxDelay', () => {
      expect(constantDelay(1, 1000, 500)).toBe(500);
    });
  });

  describe('linearDelay', () => {
    it('should increase delay linearly with attempt', () => {
      expect(linearDelay(1, 1000)).toBe(1000);
      expect(linearDelay(2, 1000)).toBe(2000);
      expect(linearDelay(3, 1000)).toBe(3000);
    });

    it('should respect maxDelay', () => {
      expect(linearDelay(10, 1000, 5000)).toBe(5000);
    });
  });

  describe('exponentialDelay', () => {
    it('should double delay with each attempt', () => {
      expect(exponentialDelay(1, 1000)).toBe(1000);
      expect(exponentialDelay(2, 1000)).toBe(2000);
      expect(exponentialDelay(3, 1000)).toBe(4000);
      expect(exponentialDelay(4, 1000)).toBe(8000);
    });

    it('should respect maxDelay', () => {
      expect(exponentialDelay(10, 1000, 10000)).toBe(10000);
    });
  });

  describe('addJitter', () => {
    it('should add jitter within expected range', () => {
      // Test multiple times due to randomness
      for (let i = 0; i < 100; i++) {
        const delay = addJitter(1000, 0.1);
        expect(delay).toBeGreaterThanOrEqual(900);
        expect(delay).toBeLessThanOrEqual(1100);
      }
    });

    it('should return non-negative values', () => {
      const delay = addJitter(100, 1.0);
      expect(delay).toBeGreaterThanOrEqual(0);
    });
  });

  describe('calculateBackoffDelay', () => {
    it('should calculate constant backoff', () => {
      expect(calculateBackoffDelay('constant', 3, 1000)).toBe(1000);
    });

    it('should calculate linear backoff', () => {
      expect(calculateBackoffDelay('linear', 3, 1000)).toBe(3000);
    });

    it('should calculate exponential backoff', () => {
      expect(calculateBackoffDelay('exponential', 3, 1000)).toBe(4000);
    });

    it('should apply jitter when specified', () => {
      // With jitter, result should be within 10% of calculated value
      const delay = calculateBackoffDelay('exponential', 3, 1000, undefined, 0.1);
      expect(delay).toBeGreaterThanOrEqual(3600);
      expect(delay).toBeLessThanOrEqual(4400);
    });
  });
});

describe('Duration Parsing', () => {
  describe('parseDuration', () => {
    it('should parse milliseconds', () => {
      expect(parseDuration(1000)).toBe(1000);
      expect(parseDuration('1000ms')).toBe(1000);
      expect(parseDuration('1000')).toBe(1000);
    });

    it('should parse seconds', () => {
      expect(parseDuration('10s')).toBe(10000);
      expect(parseDuration('1.5s')).toBe(1500);
    });

    it('should parse minutes', () => {
      expect(parseDuration('5m')).toBe(300000);
      expect(parseDuration('1.5m')).toBe(90000);
    });

    it('should parse hours', () => {
      expect(parseDuration('1h')).toBe(3600000);
      expect(parseDuration('0.5h')).toBe(1800000);
    });

    it('should throw on invalid format', () => {
      expect(() => parseDuration('invalid')).toThrow('Invalid duration format');
    });
  });

  describe('formatDuration', () => {
    it('should format milliseconds', () => {
      expect(formatDuration(500)).toBe('500ms');
    });

    it('should format seconds', () => {
      expect(formatDuration(5000)).toBe('5.0s');
      expect(formatDuration(1500)).toBe('1.5s');
    });

    it('should format minutes', () => {
      expect(formatDuration(60000)).toBe('1.0m');
      expect(formatDuration(150000)).toBe('2.5m');
    });

    it('should format hours', () => {
      expect(formatDuration(3600000)).toBe('1.0h');
    });
  });
});

describe('parseRetryConfig', () => {
  it('should return defaults for step without retry config', () => {
    const step: WorkflowStep = {
      name: 'test',
      action: 'shell',
    };
    const config = parseRetryConfig(step);
    expect(config.maxAttempts).toBe(1);
    expect(config.backoff).toBe('exponential');
  });

  it('should parse step retry config', () => {
    const step: WorkflowStep = {
      name: 'test',
      action: 'shell',
      retry: {
        maxAttempts: 3,
        delay: 5000,
        backoff: 'linear',
        maxDelay: 30000,
        jitter: 0.2,
      },
    };
    const config = parseRetryConfig(step);
    expect(config.maxAttempts).toBe(3);
    expect(config.delay).toBe(5000);
    expect(config.backoff).toBe('linear');
    expect(config.maxDelay).toBe(30000);
    expect(config.jitter).toBe(0.2);
  });
});

describe('RetryManager', () => {
  let mockHandler: ActionHandler;
  let mockContext: ActionContext;

  beforeEach(() => {
    mockHandler = {
      type: 'shell',
      canHandle: () => true,
      execute: vi.fn(),
    };

    mockContext = {
      workflow: { name: 'test', phases: [] },
      phase: { name: 'test', steps: [] },
      step: { name: 'test', action: 'shell' },
      inputs: {},
      stepOutputs: new Map(),
      env: {},
      workdir: '/test',
      signal: new AbortController().signal,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    };
  });

  it('should execute successfully on first attempt', async () => {
    const successResult: ActionResult = {
      success: true,
      output: 'success',
      duration: 100,
    };
    (mockHandler.execute as ReturnType<typeof vi.fn>).mockResolvedValue(successResult);

    const manager = new RetryManager({ maxAttempts: 3 });
    const step: WorkflowStep = { name: 'test', action: 'shell' };

    const result = await manager.executeWithRetry(mockHandler, step, mockContext);

    expect(result.result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('should retry on failure and succeed', async () => {
    const failResult: ActionResult = {
      success: false,
      output: null,
      error: 'Failed',
      duration: 100,
    };
    const successResult: ActionResult = {
      success: true,
      output: 'success',
      duration: 100,
    };

    (mockHandler.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(failResult)
      .mockResolvedValueOnce(successResult);

    const manager = new RetryManager({ maxAttempts: 3, delay: 10 });
    const step: WorkflowStep = { name: 'test', action: 'shell' };

    const result = await manager.executeWithRetry(mockHandler, step, mockContext);

    expect(result.result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.errors).toHaveLength(1);
  });

  it('should exhaust all retries on continuous failure', async () => {
    const failResult: ActionResult = {
      success: false,
      output: null,
      error: 'Failed',
      duration: 100,
    };

    (mockHandler.execute as ReturnType<typeof vi.fn>).mockResolvedValue(failResult);

    const manager = new RetryManager({ maxAttempts: 3, delay: 10 });
    const step: WorkflowStep = { name: 'test', action: 'shell' };

    const result = await manager.executeWithRetry(mockHandler, step, mockContext);

    expect(result.result.success).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.errors).toHaveLength(3);
  });

  it('should call onRetry callback before each retry', async () => {
    const failResult: ActionResult = {
      success: false,
      output: null,
      error: 'Failed',
      duration: 100,
    };
    const successResult: ActionResult = {
      success: true,
      output: 'success',
      duration: 100,
    };

    (mockHandler.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(failResult)
      .mockResolvedValueOnce(successResult);

    const onRetry = vi.fn();
    const manager = new RetryManager({ maxAttempts: 3, delay: 10 }, onRetry);
    const step: WorkflowStep = { name: 'test', action: 'shell' };

    await manager.executeWithRetry(mockHandler, step, mockContext);

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        canRetry: true,
      }),
      expect.any(Error)
    );
  });
});

describe('withTimeout', () => {
  it('should resolve if operation completes before timeout', async () => {
    const operation = Promise.resolve('success');
    const result = await withTimeout(operation, 1000);
    expect(result).toBe('success');
  });

  it('should reject if operation times out', async () => {
    const operation = new Promise((resolve) => setTimeout(resolve, 500));
    await expect(withTimeout(operation, 10)).rejects.toThrow('timed out');
  });

  it('should reject if signal is aborted', async () => {
    const controller = new AbortController();
    const operation = new Promise((resolve) => setTimeout(resolve, 1000));

    setTimeout(() => controller.abort(), 10);

    await expect(withTimeout(operation, 5000, controller.signal)).rejects.toThrow(
      'aborted'
    );
  });

  it('should reject immediately if signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const operation = Promise.resolve('success');

    await expect(withTimeout(operation, 1000, controller.signal)).rejects.toThrow(
      'aborted'
    );
  });
});
