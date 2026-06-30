import { describe, expect, it } from 'vitest';
import { resolveOrchestratorToken } from '../shared/orchestrator-token.js';

describe('resolveOrchestratorToken', () => {
  it('returns env value when only env is set', () => {
    expect(
      resolveOrchestratorToken({
        envValue: 'env-token',
        configValue: undefined,
      }),
    ).toBe('env-token');
  });

  it('returns config value when only config is set', () => {
    expect(
      resolveOrchestratorToken({
        envValue: undefined,
        configValue: 'config-token',
      }),
    ).toBe('config-token');
  });

  it('prefers env over config when both are set', () => {
    expect(
      resolveOrchestratorToken({
        envValue: 'env-token',
        configValue: 'config-token',
      }),
    ).toBe('env-token');
  });

  it('returns undefined when neither is set', () => {
    expect(
      resolveOrchestratorToken({
        envValue: undefined,
        configValue: undefined,
      }),
    ).toBeUndefined();
  });

  it('falls back to config when env is whitespace-only', () => {
    expect(
      resolveOrchestratorToken({
        envValue: '   ',
        configValue: 'config-token',
      }),
    ).toBe('config-token');
  });

  it('returns undefined when both are whitespace-only', () => {
    expect(
      resolveOrchestratorToken({
        envValue: '   ',
        configValue: '\t\n',
      }),
    ).toBeUndefined();
  });

  it('trims surrounding whitespace from env value', () => {
    expect(
      resolveOrchestratorToken({
        envValue: '  env-token  ',
        configValue: undefined,
      }),
    ).toBe('env-token');
  });

  it('trims surrounding whitespace from config value', () => {
    expect(
      resolveOrchestratorToken({
        envValue: undefined,
        configValue: '\tconfig-token\n',
      }),
    ).toBe('config-token');
  });

  it('treats empty string env as unset and falls back to config', () => {
    expect(
      resolveOrchestratorToken({
        envValue: '',
        configValue: 'config-token',
      }),
    ).toBe('config-token');
  });

  it('treats empty string config as unset', () => {
    expect(
      resolveOrchestratorToken({
        envValue: undefined,
        configValue: '',
      }),
    ).toBeUndefined();
  });
});
