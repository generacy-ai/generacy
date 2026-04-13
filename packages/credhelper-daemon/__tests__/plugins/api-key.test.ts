import { describe, it, expect, vi } from 'vitest';
import { apiKeyPlugin } from '../../src/plugins/core/api-key.js';
import type { ResolveContext, ExposureKind } from '@generacy-ai/credhelper';

describe('apiKeyPlugin', () => {
  describe('credentialSchema', () => {
    it('accepts an empty object', () => {
      const result = apiKeyPlugin.credentialSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('accepts an object with a valid upstream URL', () => {
      const result = apiKeyPlugin.credentialSchema.safeParse({
        upstream: 'https://api.example.com',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ upstream: 'https://api.example.com' });
      }
    });

    it('rejects an invalid URL for upstream', () => {
      const result = apiKeyPlugin.credentialSchema.safeParse({
        upstream: 'not-a-url',
      });
      expect(result.success).toBe(false);
    });

    it('accepts objects with extra fields (passthrough)', () => {
      const result = apiKeyPlugin.credentialSchema.safeParse({
        upstream: 'https://api.example.com',
        description: 'production key',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({
          upstream: 'https://api.example.com',
          description: 'production key',
        });
      }
    });
  });

  describe('resolve()', () => {
    it('fetches the API key from the backend and returns it with format "key"', async () => {
      const backend = {
        fetchSecret: vi.fn().mockResolvedValue('sk-abc123'),
      };
      const ctx: ResolveContext = {
        credentialId: 'my-api',
        backendKey: 'api-key-secret',
        backend,
        config: {},
      };

      const secret = await apiKeyPlugin.resolve!(ctx);

      expect(secret.value).toBe('sk-abc123');
      expect(secret.format).toBe('key');
      expect(backend.fetchSecret).toHaveBeenCalledWith('api-key-secret');
    });
  });

  describe('renderExposure()', () => {
    const secret = { value: 'sk-abc123' };

    it('renders env exposure with the configured variable name', () => {
      const result = apiKeyPlugin.renderExposure(
        'env' as ExposureKind,
        secret,
        { kind: 'env', name: 'MY_API_KEY' },
      );

      expect(result).toEqual({
        kind: 'env',
        entries: [{ key: 'MY_API_KEY', value: 'sk-abc123' }],
      });
    });

    it('uses default API_KEY name when cfg kind is not env', () => {
      const result = apiKeyPlugin.renderExposure(
        'env' as ExposureKind,
        secret,
        { kind: 'localhost-proxy', port: 8080 } as any,
      );

      expect(result).toEqual({
        kind: 'env',
        entries: [{ key: 'API_KEY', value: 'sk-abc123' }],
      });
    });

    it('renders localhost-proxy exposure with upstream from resolved config', async () => {
      // resolve() must be called first to capture the credential config
      const backend = {
        fetchSecret: vi.fn().mockResolvedValue('sk-abc123'),
      };
      const ctx: ResolveContext = {
        credentialId: 'my-api',
        backendKey: 'api-key-secret',
        backend,
        config: { upstream: 'https://api.example.com' },
      };
      await apiKeyPlugin.resolve!(ctx);

      const result = apiKeyPlugin.renderExposure(
        'localhost-proxy' as ExposureKind,
        { value: 'sk-abc123' },
        { kind: 'localhost-proxy', port: 8080 },
      );

      expect(result).toEqual({
        kind: 'localhost-proxy',
        upstream: 'https://api.example.com',
        headers: { Authorization: 'Bearer sk-abc123' },
      });
    });

    it('uses empty string for upstream when config has no upstream', async () => {
      const backend = {
        fetchSecret: vi.fn().mockResolvedValue('sk-abc123'),
      };
      const ctx: ResolveContext = {
        credentialId: 'my-api',
        backendKey: 'api-key-secret',
        backend,
        config: {},
      };
      await apiKeyPlugin.resolve!(ctx);

      const result = apiKeyPlugin.renderExposure(
        'localhost-proxy' as ExposureKind,
        { value: 'sk-abc123' },
        { kind: 'localhost-proxy', port: 8080 },
      );

      expect(result).toEqual({
        kind: 'localhost-proxy',
        upstream: '',
        headers: { Authorization: 'Bearer sk-abc123' },
      });
    });

    it('throws for unsupported exposure kinds', () => {
      expect(() =>
        apiKeyPlugin.renderExposure(
          'git-credential-helper' as ExposureKind,
          secret,
          { kind: 'git-credential-helper' },
        ),
      ).toThrow('Unsupported exposure kind: git-credential-helper');
    });
  });

  describe('metadata', () => {
    it('has type "api-key"', () => {
      expect(apiKeyPlugin.type).toBe('api-key');
    });

    it('supports env and localhost-proxy exposures', () => {
      expect(apiKeyPlugin.supportedExposures).toEqual(['env', 'localhost-proxy']);
    });
  });
});
