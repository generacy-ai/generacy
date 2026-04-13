import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validatePlugin } from '../../loader/validate.js';

function makeValidPlugin() {
  return {
    type: 'test',
    credentialSchema: z.object({ token: z.string() }),
    supportedExposures: ['env'] as const,
    renderExposure: () => ({ kind: 'env' as const, entries: [] }),
  };
}

describe('validatePlugin', () => {
  it('accepts a valid plugin', () => {
    const plugin = makeValidPlugin();
    const result = validatePlugin(plugin, 'test-plugin');
    expect(result.type).toBe('test');
  });

  it('accepts a plugin with optional scopeSchema', () => {
    const plugin = {
      ...makeValidPlugin(),
      scopeSchema: z.object({ scope: z.string() }),
    };
    const result = validatePlugin(plugin, 'test-plugin');
    expect(result.type).toBe('test');
  });

  it('throws for missing type', () => {
    const plugin = { ...makeValidPlugin(), type: undefined };
    expect(() => validatePlugin(plugin, 'test-plugin')).toThrow(
      /missing or invalid 'type'/,
    );
  });

  it('throws for empty type', () => {
    const plugin = { ...makeValidPlugin(), type: '' };
    expect(() => validatePlugin(plugin, 'test-plugin')).toThrow(
      /missing or invalid 'type'/,
    );
  });

  it('throws for invalid credentialSchema (no .parse)', () => {
    const plugin = { ...makeValidPlugin(), credentialSchema: { notASchema: true } };
    expect(() => validatePlugin(plugin, 'test-plugin')).toThrow(
      /credentialSchema is not a valid Zod schema/,
    );
  });

  it('throws for null credentialSchema', () => {
    const plugin = { ...makeValidPlugin(), credentialSchema: null };
    expect(() => validatePlugin(plugin, 'test-plugin')).toThrow(
      /credentialSchema is not a valid Zod schema/,
    );
  });

  it('throws for invalid scopeSchema', () => {
    const plugin = { ...makeValidPlugin(), scopeSchema: { notASchema: true } };
    expect(() => validatePlugin(plugin, 'test-plugin')).toThrow(
      /scopeSchema is not a valid Zod schema/,
    );
  });

  it('throws for empty supportedExposures', () => {
    const plugin = { ...makeValidPlugin(), supportedExposures: [] };
    expect(() => validatePlugin(plugin, 'test-plugin')).toThrow(
      /supportedExposures must be a non-empty array/,
    );
  });

  it('throws for invalid exposure kind', () => {
    const plugin = { ...makeValidPlugin(), supportedExposures: ['invalid-kind'] };
    expect(() => validatePlugin(plugin, 'test-plugin')).toThrow(
      /invalid kind: 'invalid-kind'/,
    );
  });

  it('throws for missing renderExposure', () => {
    const plugin = { ...makeValidPlugin(), renderExposure: undefined };
    expect(() => validatePlugin(plugin, 'test-plugin')).toThrow(
      /missing renderExposure function/,
    );
  });

  it('throws for non-function renderExposure', () => {
    const plugin = { ...makeValidPlugin(), renderExposure: 'not-a-function' };
    expect(() => validatePlugin(plugin, 'test-plugin')).toThrow(
      /missing renderExposure function/,
    );
  });

  it('includes plugin name in all error messages', () => {
    const plugin = { ...makeValidPlugin(), type: undefined };
    expect(() => validatePlugin(plugin, 'my-custom-plugin')).toThrow(
      'my-custom-plugin',
    );
  });
});
