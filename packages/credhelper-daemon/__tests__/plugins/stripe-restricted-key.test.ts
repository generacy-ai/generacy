import { describe, it, expect, vi } from 'vitest';
import { stripeRestrictedKeyPlugin } from '../../src/plugins/core/stripe-restricted-key.js';
import type { ResolveContext, ExposureKind } from '@generacy-ai/credhelper';

describe('stripeRestrictedKeyPlugin', () => {
  describe('credentialSchema', () => {
    it('accepts an empty object', () => {
      const result = stripeRestrictedKeyPlugin.credentialSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('accepts objects with extra fields (passthrough)', () => {
      const result = stripeRestrictedKeyPlugin.credentialSchema.safeParse({
        account: 'acct_123',
        description: 'test key',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ account: 'acct_123', description: 'test key' });
      }
    });
  });

  describe('resolve()', () => {
    it('fetches the restricted key from the backend and returns it with format "key"', async () => {
      const backend = {
        fetchSecret: vi.fn().mockResolvedValue('rk_test_abc123'),
      };
      const ctx: ResolveContext = {
        credentialId: 'stripe',
        backendKey: 'stripe-key',
        backend,
        config: {},
      };

      const secret = await stripeRestrictedKeyPlugin.resolve!(ctx);

      expect(secret.value).toBe('rk_test_abc123');
      expect(secret.format).toBe('key');
      expect(backend.fetchSecret).toHaveBeenCalledWith('stripe-key');
    });
  });

  describe('renderExposure()', () => {
    const secret = { value: 'rk_test_abc123' };

    it('renders env exposure with the configured variable name', () => {
      const result = stripeRestrictedKeyPlugin.renderExposure(
        'env' as ExposureKind,
        secret,
        { kind: 'env', name: 'STRIPE_API_KEY' },
      );

      expect(result).toEqual({
        kind: 'env',
        entries: [{ key: 'STRIPE_API_KEY', value: 'rk_test_abc123' }],
      });
    });

    it('uses default STRIPE_API_KEY name when cfg kind is not env', () => {
      const result = stripeRestrictedKeyPlugin.renderExposure(
        'env' as ExposureKind,
        secret,
        { kind: 'localhost-proxy', port: 8080 } as any,
      );

      expect(result).toEqual({
        kind: 'env',
        entries: [{ key: 'STRIPE_API_KEY', value: 'rk_test_abc123' }],
      });
    });

    it('throws for unsupported exposure kinds', () => {
      expect(() =>
        stripeRestrictedKeyPlugin.renderExposure(
          'localhost-proxy' as ExposureKind,
          secret,
          { kind: 'localhost-proxy', port: 8080 } as any,
        ),
      ).toThrow('Unsupported exposure kind: localhost-proxy');
    });
  });

  describe('metadata', () => {
    it('has type "stripe-restricted-key"', () => {
      expect(stripeRestrictedKeyPlugin.type).toBe('stripe-restricted-key');
    });

    it('supports only env exposure', () => {
      expect(stripeRestrictedKeyPlugin.supportedExposures).toEqual(['env']);
    });
  });
});
