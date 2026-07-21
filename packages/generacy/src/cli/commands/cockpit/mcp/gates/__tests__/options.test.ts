import { describe, expect, it, vi } from 'vitest';
import { resolveGateOptions } from '../options.js';

describe('resolveGateOptions (#1022 — R2 precedence)', () => {
  const noopEnv: NodeJS.ProcessEnv = {};

  it('arg wins over env and default for baseUrl', () => {
    const spy = vi.fn(async () => new Response('{}'));
    const opts = resolveGateOptions(
      { orchestratorUrl: 'http://arg.example', fetchImpl: spy },
      { ORCHESTRATOR_URL: 'http://env.example' },
    );
    expect(opts.baseUrl).toBe('http://arg.example');
  });

  it('env wins over default when arg omitted', () => {
    const opts = resolveGateOptions({}, { ORCHESTRATOR_URL: 'http://env.example' });
    expect(opts.baseUrl).toBe('http://env.example');
  });

  it('falls back to default when both arg and env omitted', () => {
    const opts = resolveGateOptions({}, noopEnv);
    expect(opts.baseUrl).toBe('http://127.0.0.1:3100');
  });

  it('orchestratorTimeoutMs defaults to 5000', () => {
    const opts = resolveGateOptions({}, noopEnv);
    expect(opts.timeoutMs).toBe(5000);
  });

  it('orchestratorTimeoutMs arg wins over default', () => {
    const opts = resolveGateOptions({ orchestratorTimeoutMs: 100 }, noopEnv);
    expect(opts.timeoutMs).toBe(100);
  });

  it('fetchImpl arg wins; falls back to global fetch when omitted', () => {
    const spy = vi.fn(async () => new Response('{}'));
    const withArg = resolveGateOptions({ fetchImpl: spy }, noopEnv);
    expect(withArg.fetchImpl).toBe(spy);

    const withoutArg = resolveGateOptions({}, noopEnv);
    expect(withoutArg.fetchImpl).toBe(fetch);
  });

  it('env parameter defaulted to process.env but does not read it when custom env passed', () => {
    // Injection seam: passing a custom env silences process.env entirely for this call.
    const savedProcEnv = process.env['ORCHESTRATOR_URL'];
    process.env['ORCHESTRATOR_URL'] = 'http://process-env.example';
    try {
      const withCustomEnv = resolveGateOptions({}, {});
      expect(withCustomEnv.baseUrl).toBe('http://127.0.0.1:3100');
      const withDefaultEnv = resolveGateOptions({});
      expect(withDefaultEnv.baseUrl).toBe('http://process-env.example');
    } finally {
      if (savedProcEnv === undefined) delete process.env['ORCHESTRATOR_URL'];
      else process.env['ORCHESTRATOR_URL'] = savedProcEnv;
    }
  });
});
