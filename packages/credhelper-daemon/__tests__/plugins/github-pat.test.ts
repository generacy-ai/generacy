import { describe, it, expect, vi } from 'vitest';
import { githubPatPlugin } from '../../src/plugins/core/github-pat.js';
import type { ResolveContext, ExposureKind } from '@generacy-ai/credhelper';

describe('githubPatPlugin', () => {
  describe('credentialSchema', () => {
    it('accepts an empty object', () => {
      const result = githubPatPlugin.credentialSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('accepts objects with extra fields (passthrough)', () => {
      const result = githubPatPlugin.credentialSchema.safeParse({
        owner: 'acme',
        scopes: ['repo'],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ owner: 'acme', scopes: ['repo'] });
      }
    });
  });

  describe('resolve()', () => {
    it('fetches the PAT from the backend and returns it as a token', async () => {
      const backend = {
        fetchSecret: vi.fn().mockResolvedValue('ghp_abc123'),
      };
      const ctx: ResolveContext = {
        credentialId: 'gh',
        backendKey: 'github-token',
        backend,
        config: {},
      };

      const secret = await githubPatPlugin.resolve!(ctx);

      expect(secret.value).toBe('ghp_abc123');
      expect(secret.format).toBe('token');
      expect(backend.fetchSecret).toHaveBeenCalledWith('github-token');
    });
  });

  describe('renderExposure()', () => {
    const secret = { value: 'ghp_abc123' };

    it('renders env exposure with the configured variable name', () => {
      const result = githubPatPlugin.renderExposure(
        'env' as ExposureKind,
        secret,
        { kind: 'env', name: 'GITHUB_TOKEN' },
      );

      expect(result).toEqual({
        kind: 'env',
        entries: [{ key: 'GITHUB_TOKEN', value: 'ghp_abc123' }],
      });
    });

    it('renders git-credential-helper exposure for github.com', () => {
      const result = githubPatPlugin.renderExposure(
        'git-credential-helper' as ExposureKind,
        secret,
        { kind: 'git-credential-helper' },
      );

      expect(result).toEqual({
        kind: 'git-credential-helper',
        host: 'github.com',
        protocol: 'https',
        username: 'x-access-token',
        password: 'ghp_abc123',
      });
    });

    it('throws for unsupported exposure kinds', () => {
      expect(() =>
        githubPatPlugin.renderExposure(
          'localhost-proxy' as ExposureKind,
          secret,
          { kind: 'localhost-proxy', port: 8080 },
        ),
      ).toThrow('Unsupported exposure kind: localhost-proxy');
    });
  });
});
