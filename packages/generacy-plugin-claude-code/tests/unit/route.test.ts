import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GATEWAY_CONFIG_DIR,
  GatewayRouteUnavailableError,
  _resetGatewayProvisionCacheForTests,
  assertGatewayProvisioned,
  resolveGatewayConfigDir,
  resolveRoute,
} from '../../src/launch/route.js';

describe('resolveRoute (SC-001)', () => {
  it.each([
    ['claude-opus-4-7', 'subscription'],
    ['opus', 'subscription'],
    ['sonnet', 'subscription'],
    ['claude-sonnet-4-5[1m]', 'subscription'],
    ['', 'subscription'],
  ] as const)('%j → %s', (model, expected) => {
    expect(resolveRoute(model)).toBe(expected);
  });

  it('undefined → subscription', () => {
    expect(resolveRoute(undefined)).toBe('subscription');
  });

  it.each([
    ['openai/gpt-5.5', 'gateway'],
    ['openrouter/qwen/qwen3.5-coder', 'gateway'],
  ] as const)('%j → %s', (model, expected) => {
    expect(resolveRoute(model)).toBe(expected);
  });
});

describe('resolveGatewayConfigDir', () => {
  const ENV_KEY = 'GENERACY_CLAUDE_GATEWAY_CONFIG_DIR';
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = original;
  });

  it('explicit option wins over env and default', () => {
    process.env[ENV_KEY] = '/from/env';
    expect(resolveGatewayConfigDir('/explicit')).toBe('/explicit');
  });

  it('env wins over default when no explicit option', () => {
    process.env[ENV_KEY] = '/from/env';
    expect(resolveGatewayConfigDir()).toBe('/from/env');
  });

  it('falls back to the built-in default', () => {
    delete process.env[ENV_KEY];
    expect(resolveGatewayConfigDir()).toBe(DEFAULT_GATEWAY_CONFIG_DIR);
  });

  it('empty-string explicit still wins over env (nullish only)', () => {
    process.env[ENV_KEY] = '/from/env';
    expect(resolveGatewayConfigDir('')).toBe('');
  });
});

describe('assertGatewayProvisioned cache semantics (Q3=A)', () => {
  let dir: string;

  beforeEach(() => {
    _resetGatewayProvisionCacheForTests();
    dir = mkdtempSync(join(tmpdir(), 'gw-route-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when settings.json is absent', () => {
    expect(() => assertGatewayProvisioned('openai/gpt-5.5', dir)).toThrow(
      GatewayRouteUnavailableError,
    );
  });

  it('missing result is never cached — provisioning takes effect on next call', () => {
    expect(() => assertGatewayProvisioned('openai/gpt-5.5', dir)).toThrow();
    writeFileSync(join(dir, 'settings.json'), '{}');
    expect(() => assertGatewayProvisioned('openai/gpt-5.5', dir)).not.toThrow();
  });

  it('positive result is cached — passes even after settings.json is deleted', () => {
    writeFileSync(join(dir, 'settings.json'), '{}');
    expect(() => assertGatewayProvisioned('openai/gpt-5.5', dir)).not.toThrow();
    rmSync(join(dir, 'settings.json'));
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
    expect(() => assertGatewayProvisioned('openai/gpt-5.5', dir)).not.toThrow();
  });

  it('distinct dirs are keyed independently', () => {
    const other = mkdtempSync(join(tmpdir(), 'gw-route-'));
    try {
      writeFileSync(join(dir, 'settings.json'), '{}');
      expect(() => assertGatewayProvisioned('openai/gpt-5.5', dir)).not.toThrow();
      expect(() => assertGatewayProvisioned('openai/gpt-5.5', other)).toThrow(
        GatewayRouteUnavailableError,
      );
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('GatewayRouteUnavailableError (SC-003)', () => {
  it('is an Error and a GatewayRouteUnavailableError with populated fields + 3-token message', () => {
    const model = 'openrouter/qwen/qwen3.5-coder';
    const gatewayConfigDir = '/home/node/.claude-gateway';
    const err = new GatewayRouteUnavailableError(model, gatewayConfigDir);

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(GatewayRouteUnavailableError);
    expect(err.name).toBe('GatewayRouteUnavailableError');
    expect(err.model).toBe(model);
    expect(err.gatewayConfigDir).toBe(gatewayConfigDir);
    expect(err.message).toContain(model);
    expect(err.message).toContain(gatewayConfigDir);
    expect(err.message).toContain('GENERACY_LLM_GATEWAY_URL');
  });
});
