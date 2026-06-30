import { describe, expect, it } from 'vitest';
import { createOrchestratorClient } from '@generacy-ai/cockpit';
import { resolveOrchestratorToken } from '../shared/orchestrator-token.js';

/**
 * Integration test for the env → resolveOrchestratorToken → createOrchestratorClient
 * chain. Proves that the token-precedence helper resolves the right value and
 * that the resolved value drives `createOrchestratorClient`'s stub-vs-live
 * dispatch. No global process.env mutation — values are passed directly into
 * `resolveOrchestratorToken`.
 */
describe('cockpit status token precedence', () => {
  it('env set + config set → resolved is env; client is live', () => {
    const token = resolveOrchestratorToken({
      envValue: 'env-x',
      configValue: 'cfg-y',
    });
    expect(token).toBe('env-x');
    const client = createOrchestratorClient({ token });
    expect(client.isAvailable()).toBe(true);
  });

  it('env unset + config set → resolved is config; client is live', () => {
    const token = resolveOrchestratorToken({
      envValue: undefined,
      configValue: 'cfg-y',
    });
    expect(token).toBe('cfg-y');
    const client = createOrchestratorClient({ token });
    expect(client.isAvailable()).toBe(true);
  });

  it('both unset → resolved is undefined; client is stub', () => {
    const token = resolveOrchestratorToken({
      envValue: undefined,
      configValue: undefined,
    });
    expect(token).toBeUndefined();
    const orchestratorOptions: { token?: string } = {};
    if (token != null) {
      orchestratorOptions.token = token;
    }
    const client = createOrchestratorClient(orchestratorOptions);
    expect(client.isAvailable()).toBe(false);
  });

  it('whitespace env + config set → resolved is config; client is live', () => {
    const token = resolveOrchestratorToken({
      envValue: '   ',
      configValue: 'cfg-y',
    });
    expect(token).toBe('cfg-y');
    const client = createOrchestratorClient({ token });
    expect(client.isAvailable()).toBe(true);
  });

  it('whitespace env + whitespace config → resolved is undefined; client is stub', () => {
    const token = resolveOrchestratorToken({
      envValue: '   ',
      configValue: '\t\n',
    });
    expect(token).toBeUndefined();
    const orchestratorOptions: { token?: string } = {};
    if (token != null) {
      orchestratorOptions.token = token;
    }
    const client = createOrchestratorClient(orchestratorOptions);
    expect(client.isAvailable()).toBe(false);
  });

  it('empty env string + config set → resolved is config; client is live', () => {
    const token = resolveOrchestratorToken({
      envValue: '',
      configValue: 'cfg-y',
    });
    expect(token).toBe('cfg-y');
    const client = createOrchestratorClient({ token });
    expect(client.isAvailable()).toBe(true);
  });
});
