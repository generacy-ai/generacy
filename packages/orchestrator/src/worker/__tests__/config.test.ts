import { describe, it, expect } from 'vitest';
import { WorkerConfigSchema } from '../config.js';

describe('WorkerConfigSchema - maxImplementRetries', () => {
  it('defaults to 2', () => {
    const config = WorkerConfigSchema.parse({});
    expect(config.maxImplementRetries).toBe(2);
  });

  it('accepts valid values 0 through 5', () => {
    for (const value of [0, 1, 2, 3, 4, 5]) {
      const config = WorkerConfigSchema.parse({ maxImplementRetries: value });
      expect(config.maxImplementRetries).toBe(value);
    }
  });

  it('rejects negative values', () => {
    expect(() => WorkerConfigSchema.parse({ maxImplementRetries: -1 })).toThrow();
  });

  it('rejects values greater than 5', () => {
    expect(() => WorkerConfigSchema.parse({ maxImplementRetries: 6 })).toThrow();
  });

  it('rejects non-integer values', () => {
    expect(() => WorkerConfigSchema.parse({ maxImplementRetries: 1.5 })).toThrow();
  });

  it('rejects string values', () => {
    expect(() => WorkerConfigSchema.parse({ maxImplementRetries: '2' })).toThrow();
  });
});
