import { describe, it, expect } from 'vitest';
import { CORE_PLUGINS } from '../../src/plugins/core/index.js';

describe('CORE_PLUGINS', () => {
  it('contains exactly 7 plugins', () => {
    expect(CORE_PLUGINS).toHaveLength(7);
  });

  it('each plugin has a unique type', () => {
    const types = CORE_PLUGINS.map((p) => p.type);
    expect(new Set(types).size).toBe(7);
  });

  it('includes all expected plugin types', () => {
    const types = new Set(CORE_PLUGINS.map((p) => p.type));
    expect(types).toContain('github-app');
    expect(types).toContain('github-pat');
    expect(types).toContain('gcp-service-account');
    expect(types).toContain('aws-sts');
    expect(types).toContain('stripe-restricted-key');
    expect(types).toContain('api-key');
    expect(types).toContain('env-passthrough');
  });

  it('each plugin has a valid interface shape', () => {
    for (const plugin of CORE_PLUGINS) {
      expect(typeof plugin.type).toBe('string');
      expect(plugin.type.length).toBeGreaterThan(0);
      expect(plugin.credentialSchema).toBeDefined();
      expect(typeof plugin.credentialSchema.parse).toBe('function');
      expect(Array.isArray(plugin.supportedExposures)).toBe(true);
      expect(plugin.supportedExposures.length).toBeGreaterThan(0);
      expect(typeof plugin.renderExposure).toBe('function');
      expect(
        typeof plugin.mint === 'function' || typeof plugin.resolve === 'function',
      ).toBe(true);
    }
  });

  it('each plugin has either mint or resolve (not both missing)', () => {
    for (const plugin of CORE_PLUGINS) {
      const hasMint = typeof plugin.mint === 'function';
      const hasResolve = typeof plugin.resolve === 'function';
      expect(hasMint || hasResolve).toBe(true);
    }
  });
});
