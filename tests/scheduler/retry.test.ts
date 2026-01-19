/**
 * Tests for retry delay calculation used by the job processor.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateRetryDelay,
  calculateRetryDelayDeterministic,
} from '../../src/utils/retry.js';
import { DEFAULT_JOB_RETRY_CONFIG } from '../../src/scheduler/types.js';

describe('Retry delay calculation for jobs', () => {
  describe('calculateRetryDelayDeterministic', () => {
    it('should calculate correct delay for first attempt', () => {
      const delay = calculateRetryDelayDeterministic(0, DEFAULT_JOB_RETRY_CONFIG);
      expect(delay).toBe(1000); // initialDelay
    });

    it('should calculate correct delay for second attempt', () => {
      const delay = calculateRetryDelayDeterministic(1, DEFAULT_JOB_RETRY_CONFIG);
      expect(delay).toBe(2000); // 1000 * 2^1
    });

    it('should calculate correct delay for third attempt', () => {
      const delay = calculateRetryDelayDeterministic(2, DEFAULT_JOB_RETRY_CONFIG);
      expect(delay).toBe(4000); // 1000 * 2^2
    });

    it('should respect maxDelay', () => {
      const delay = calculateRetryDelayDeterministic(10, DEFAULT_JOB_RETRY_CONFIG);
      expect(delay).toBe(30000); // maxDelay from DEFAULT_JOB_RETRY_CONFIG
    });

    it('should use custom config', () => {
      const config = {
        maxAttempts: 5,
        initialDelay: 500,
        maxDelay: 10000,
        backoffFactor: 3,
      };

      expect(calculateRetryDelayDeterministic(0, config)).toBe(500);
      expect(calculateRetryDelayDeterministic(1, config)).toBe(1500); // 500 * 3^1
      expect(calculateRetryDelayDeterministic(2, config)).toBe(4500); // 500 * 3^2
      expect(calculateRetryDelayDeterministic(3, config)).toBe(10000); // capped at maxDelay
    });
  });

  describe('calculateRetryDelay (with jitter)', () => {
    it('should include jitter within 10% of base delay', () => {
      const attempts = 100;
      const delays: number[] = [];

      for (let i = 0; i < attempts; i++) {
        delays.push(calculateRetryDelay(0, DEFAULT_JOB_RETRY_CONFIG));
      }

      // All delays should be between base (1000) and base + 10% (1100)
      for (const delay of delays) {
        expect(delay).toBeGreaterThanOrEqual(1000);
        expect(delay).toBeLessThanOrEqual(1100);
      }

      // There should be variation (not all the same)
      const uniqueDelays = new Set(delays.map(d => Math.floor(d)));
      expect(uniqueDelays.size).toBeGreaterThan(1);
    });

    it('should respect maxDelay even with jitter', () => {
      const delays: number[] = [];

      for (let i = 0; i < 100; i++) {
        delays.push(calculateRetryDelay(10, DEFAULT_JOB_RETRY_CONFIG));
      }

      // All delays should be at most maxDelay
      for (const delay of delays) {
        expect(delay).toBeLessThanOrEqual(DEFAULT_JOB_RETRY_CONFIG.maxDelay);
      }
    });
  });

  describe('DEFAULT_JOB_RETRY_CONFIG', () => {
    it('should have expected defaults', () => {
      expect(DEFAULT_JOB_RETRY_CONFIG.maxAttempts).toBe(3);
      expect(DEFAULT_JOB_RETRY_CONFIG.initialDelay).toBe(1000);
      expect(DEFAULT_JOB_RETRY_CONFIG.maxDelay).toBe(30000);
      expect(DEFAULT_JOB_RETRY_CONFIG.backoffFactor).toBe(2);
    });

    it('should produce expected sequence of delays', () => {
      const delays = [0, 1, 2].map(attempt =>
        calculateRetryDelayDeterministic(attempt, DEFAULT_JOB_RETRY_CONFIG)
      );

      expect(delays).toEqual([1000, 2000, 4000]);
    });
  });
});
