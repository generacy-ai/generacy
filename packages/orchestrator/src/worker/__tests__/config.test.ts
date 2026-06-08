import { describe, it, expect } from 'vitest';
import { WorkerConfigSchema, resolvePhaseTimeoutMs } from '../config.js';

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

describe('WorkerConfigSchema - phaseTimeoutOverrides', () => {
  it('defaults plan and implement to 60 minutes', () => {
    const config = WorkerConfigSchema.parse({});
    expect(config.phaseTimeoutMs).toBe(1_200_000);
    expect(config.phaseTimeoutOverrides.plan).toBe(3_600_000);
    expect(config.phaseTimeoutOverrides.implement).toBe(3_600_000);
    expect(config.phaseTimeoutOverrides.specify).toBeUndefined();
  });

  it('keeps sibling defaults when only one phase is overridden (partial object)', () => {
    const config = WorkerConfigSchema.parse({ phaseTimeoutOverrides: { plan: 2_400_000 } });
    expect(config.phaseTimeoutOverrides.plan).toBe(2_400_000);
    // implement default must survive a partial override of plan
    expect(config.phaseTimeoutOverrides.implement).toBe(3_600_000);
  });

  it('rejects overrides below the 60s minimum', () => {
    expect(() => WorkerConfigSchema.parse({ phaseTimeoutOverrides: { plan: 30_000 } })).toThrow();
  });
});

describe('resolvePhaseTimeoutMs', () => {
  it('returns the per-phase override when present', () => {
    const config = WorkerConfigSchema.parse({ phaseTimeoutMs: 1_200_000 });
    expect(resolvePhaseTimeoutMs(config, 'plan')).toBe(3_600_000);
    expect(resolvePhaseTimeoutMs(config, 'implement')).toBe(3_600_000);
  });

  it('falls back to phaseTimeoutMs for phases without an override', () => {
    const config = WorkerConfigSchema.parse({ phaseTimeoutMs: 1_200_000 });
    expect(resolvePhaseTimeoutMs(config, 'specify')).toBe(1_200_000);
    expect(resolvePhaseTimeoutMs(config, 'clarify')).toBe(1_200_000);
    expect(resolvePhaseTimeoutMs(config, 'tasks')).toBe(1_200_000);
  });

  it('falls back to phaseTimeoutMs when overrides are absent (hand-built config)', () => {
    // Configs constructed directly (tests, callers) bypass Zod and omit the field.
    const config = { phaseTimeoutMs: 720_000 } as unknown as Parameters<typeof resolvePhaseTimeoutMs>[0];
    expect(resolvePhaseTimeoutMs(config, 'plan')).toBe(720_000);
  });
});
