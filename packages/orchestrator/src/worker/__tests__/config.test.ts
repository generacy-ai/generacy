import { describe, it, expect } from 'vitest';
import { WorkerConfigSchema, resolvePhaseTimeoutMs, applyRepoValidateOverrides } from '../config.js';

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

describe('WorkerConfigSchema - preValidateCommand default (degrade)', () => {
  const DEFAULT_PRE_VALIDATE_COMMAND =
    "pnpm install && if [ -f pnpm-workspace.yaml ] && ls packages/*/package.json >/dev/null 2>&1; then pnpm -r --filter './packages/*' build; fi";

  it('resolves to the degrade shell string byte-exact (SC-005)', () => {
    const config = WorkerConfigSchema.parse({});
    expect(config.preValidateCommand).toBe(DEFAULT_PRE_VALIDATE_COMMAND);
  });

  it('honors a custom preValidateCommand override', () => {
    const config = WorkerConfigSchema.parse({ preValidateCommand: 'npm ci' });
    expect(config.preValidateCommand).toBe('npm ci');
  });

  it('preserves an explicit empty preValidateCommand (skip install)', () => {
    const config = WorkerConfigSchema.parse({ preValidateCommand: '' });
    expect(config.preValidateCommand).toBe('');
  });

  it('retains the new default when only validateCommand is overridden', () => {
    const config = WorkerConfigSchema.parse({ validateCommand: 'pnpm build' });
    expect(config.validateCommand).toBe('pnpm build');
    expect(config.preValidateCommand).toBe(DEFAULT_PRE_VALIDATE_COMMAND);
  });
});

describe('applyRepoValidateOverrides', () => {
  const base = WorkerConfigSchema.parse({});

  it('returns the same config object when settings are null/undefined', () => {
    expect(applyRepoValidateOverrides(base, null)).toBe(base);
    expect(applyRepoValidateOverrides(base, undefined)).toBe(base);
  });

  it('returns the same config object when no validate fields are set', () => {
    expect(applyRepoValidateOverrides(base, { labelMonitor: true })).toBe(base);
  });

  it('overrides validateCommand only', () => {
    const result = applyRepoValidateOverrides(base, { validateCommand: 'pnpm build' });
    expect(result).not.toBe(base);
    expect(result.validateCommand).toBe('pnpm build');
    // preValidateCommand falls back to the global default
    expect(result.preValidateCommand).toBe(base.preValidateCommand);
  });

  it('overrides both validate commands', () => {
    const result = applyRepoValidateOverrides(base, {
      validateCommand: 'pnpm build',
      preValidateCommand: 'pnpm install',
    });
    expect(result.validateCommand).toBe('pnpm build');
    expect(result.preValidateCommand).toBe('pnpm install');
  });

  it('preserves an explicit empty preValidateCommand (skip install)', () => {
    const result = applyRepoValidateOverrides(base, { preValidateCommand: '' });
    expect(result).not.toBe(base);
    expect(result.preValidateCommand).toBe('');
    expect(result.validateCommand).toBe(base.validateCommand);
  });

  it('does not mutate the input config', () => {
    const snapshot = base.validateCommand;
    applyRepoValidateOverrides(base, { validateCommand: 'pnpm build' });
    expect(base.validateCommand).toBe(snapshot);
  });
});
