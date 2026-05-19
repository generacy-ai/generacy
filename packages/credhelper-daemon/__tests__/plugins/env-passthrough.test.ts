import { describe, it, expect, vi } from 'vitest';
import { envPassthroughPlugin } from '../../src/plugins/core/env-passthrough.js';
import type { ResolveContext, ExposureKind } from '@generacy-ai/credhelper';

describe('envPassthroughPlugin', () => {
  describe('credentialSchema', () => {
    it('accepts an empty object', () => {
      const result = envPassthroughPlugin.credentialSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('accepts objects with extra fields (passthrough)', () => {
      const result = envPassthroughPlugin.credentialSchema.safeParse({
        description: 'pass-through env var',
        optional: true,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ description: 'pass-through env var', optional: true });
      }
    });
  });

  describe('resolve()', () => {
    it('fetches the value from the backend using backendKey and returns it with format "opaque"', async () => {
      const backend = {
        fetchSecret: vi.fn().mockResolvedValue('my-env-value'),
      };
      const ctx: ResolveContext = {
        credentialId: 'env-pass',
        backendKey: 'GITHUB_TOKEN',
        backend,
        config: {},
      };

      const secret = await envPassthroughPlugin.resolve!(ctx);

      expect(secret.value).toBe('my-env-value');
      expect(secret.format).toBe('opaque');
      expect(backend.fetchSecret).toHaveBeenCalledWith('GITHUB_TOKEN');
    });
  });

  describe('renderExposure()', () => {
    const secret = { value: 'my-env-value' };

    it('renders env exposure with the configured variable name', () => {
      const result = envPassthroughPlugin.renderExposure(
        'env' as ExposureKind,
        secret,
        { kind: 'env', name: 'MY_VAR' },
      );

      expect(result).toEqual({
        kind: 'env',
        entries: [{ key: 'MY_VAR', value: 'my-env-value' }],
      });
    });

    it('uses default SECRET name when cfg kind is not env', () => {
      const result = envPassthroughPlugin.renderExposure(
        'env' as ExposureKind,
        secret,
        { kind: 'localhost-proxy', port: 8080 } as any,
      );

      expect(result).toEqual({
        kind: 'env',
        entries: [{ key: 'SECRET', value: 'my-env-value' }],
      });
    });

    it('throws for unsupported exposure kinds', () => {
      expect(() =>
        envPassthroughPlugin.renderExposure(
          'localhost-proxy' as ExposureKind,
          secret,
          { kind: 'localhost-proxy', port: 8080 } as any,
        ),
      ).toThrow('Unsupported exposure kind: localhost-proxy');
    });
  });

  describe('metadata', () => {
    it('has type "env-passthrough"', () => {
      expect(envPassthroughPlugin.type).toBe('env-passthrough');
    });

    it('supports only env exposure', () => {
      expect(envPassthroughPlugin.supportedExposures).toEqual(['env']);
    });
  });
});
