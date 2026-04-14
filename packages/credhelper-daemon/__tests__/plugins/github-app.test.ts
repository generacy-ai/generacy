import { githubAppPlugin } from '../../src/plugins/core/github-app.js';
import type { MintContext, BackendClient } from '@generacy-ai/credhelper';

// Generate an RSA key pair for testing JWT signing
import crypto from 'node:crypto';

const { privateKey: testPrivateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

describe('githubAppPlugin', () => {
  describe('credentialSchema', () => {
    it('accepts valid config with appId and installationId', () => {
      const result = githubAppPlugin.credentialSchema.safeParse({
        appId: 123,
        installationId: 456,
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing appId', () => {
      const result = githubAppPlugin.credentialSchema.safeParse({
        installationId: 456,
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing installationId', () => {
      const result = githubAppPlugin.credentialSchema.safeParse({
        appId: 123,
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-positive appId', () => {
      const result = githubAppPlugin.credentialSchema.safeParse({
        appId: 0,
        installationId: 456,
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-positive installationId', () => {
      const result = githubAppPlugin.credentialSchema.safeParse({
        appId: 123,
        installationId: -1,
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer appId', () => {
      const result = githubAppPlugin.credentialSchema.safeParse({
        appId: 1.5,
        installationId: 456,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('scopeSchema', () => {
    it('accepts full scope with repositories and permissions', () => {
      const result = githubAppPlugin.scopeSchema!.safeParse({
        repositories: ['my-repo'],
        permissions: { contents: 'read' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts empty object', () => {
      const result = githubAppPlugin.scopeSchema!.safeParse({});
      expect(result.success).toBe(true);
    });

    it('accepts partial scope with only repositories', () => {
      const result = githubAppPlugin.scopeSchema!.safeParse({
        repositories: ['repo-a', 'repo-b'],
      });
      expect(result.success).toBe(true);
    });

    it('accepts partial scope with only permissions', () => {
      const result = githubAppPlugin.scopeSchema!.safeParse({
        permissions: { issues: 'write', pull_requests: 'read' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('mint()', () => {
    let mockBackend: BackendClient;

    beforeEach(() => {
      mockBackend = {
        fetchSecret: vi.fn().mockResolvedValue(testPrivateKey),
      };
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns token and expiration on successful mint', async () => {
      const expiresAt = '2026-01-01T00:00:00Z';

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token: 'ghs_abc123', expires_at: expiresAt }),
        text: () => Promise.resolve(''),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'cred-1',
        backendKey: 'github-app-key',
        backend: mockBackend,
        scope: { repositories: ['my-repo'], permissions: { contents: 'read' } },
        ttl: 3600,
        config: { appId: 123, installationId: 456 },
      };

      const result = await githubAppPlugin.mint!(ctx);

      expect(result.value).toEqual({ value: 'ghs_abc123', format: 'token' });
      expect(result.expiresAt).toEqual(new Date(expiresAt));
    });

    it('calls fetchSecret with the backendKey', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token: 'ghs_test', expires_at: '2026-01-01T00:00:00Z' }),
        text: () => Promise.resolve(''),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'cred-1',
        backendKey: 'my-secret-key',
        backend: mockBackend,
        scope: {},
        ttl: 3600,
        config: { appId: 100, installationId: 200 },
      };

      await githubAppPlugin.mint!(ctx);

      expect(mockBackend.fetchSecret).toHaveBeenCalledWith('my-secret-key');
    });

    it('calls the correct GitHub API endpoint', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token: 'ghs_test', expires_at: '2026-01-01T00:00:00Z' }),
        text: () => Promise.resolve(''),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'cred-1',
        backendKey: 'key',
        backend: mockBackend,
        scope: {},
        ttl: 3600,
        config: { appId: 100, installationId: 789 },
      };

      await githubAppPlugin.mint!(ctx);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.github.com/app/installations/789/access_tokens',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Accept: 'application/vnd.github+json',
          }),
        }),
      );
    });

    it('includes repositories and permissions in the request body', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token: 'ghs_test', expires_at: '2026-01-01T00:00:00Z' }),
        text: () => Promise.resolve(''),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'cred-1',
        backendKey: 'key',
        backend: mockBackend,
        scope: { repositories: ['repo-a'], permissions: { contents: 'write' } },
        ttl: 3600,
        config: { appId: 100, installationId: 200 },
      };

      await githubAppPlugin.mint!(ctx);

      const callBody = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      expect(callBody.repositories).toEqual(['repo-a']);
      expect(callBody.permissions).toEqual({ contents: 'write' });
    });

    it('omits repositories and permissions from body when scope is empty', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token: 'ghs_test', expires_at: '2026-01-01T00:00:00Z' }),
        text: () => Promise.resolve(''),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'cred-1',
        backendKey: 'key',
        backend: mockBackend,
        scope: {},
        ttl: 3600,
        config: { appId: 100, installationId: 200 },
      };

      await githubAppPlugin.mint!(ctx);

      const callBody = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string);
      expect(callBody).toEqual({});
    });

    it('throws on non-ok GitHub API response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('Unauthorized'),
        json: () => Promise.resolve({}),
      } as unknown as Response);

      const ctx: MintContext = {
        credentialId: 'cred-1',
        backendKey: 'key',
        backend: mockBackend,
        scope: {},
        ttl: 3600,
        config: { appId: 100, installationId: 200 },
      };

      await expect(githubAppPlugin.mint!(ctx)).rejects.toThrow(
        'GitHub API error (401): Unauthorized',
      );
    });

    it('sends Authorization header with Bearer JWT', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ token: 'ghs_test', expires_at: '2026-01-01T00:00:00Z' }),
        text: () => Promise.resolve(''),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'cred-1',
        backendKey: 'key',
        backend: mockBackend,
        scope: {},
        ttl: 3600,
        config: { appId: 100, installationId: 200 },
      };

      await githubAppPlugin.mint!(ctx);

      const headers = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Bearer /);

      // Verify the JWT has 3 parts
      const jwt = headers.Authorization.replace('Bearer ', '');
      const parts = jwt.split('.');
      expect(parts).toHaveLength(3);

      // Verify JWT header
      const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
      expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });

      // Verify JWT payload
      const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
      expect(payload.iss).toBe(100);
    });
  });

  describe('renderExposure()', () => {
    const secret = { value: 'ghs_testtoken123', format: 'token' as const };

    it('returns env exposure with configured name', () => {
      const result = githubAppPlugin.renderExposure(
        'env',
        secret,
        { kind: 'env', name: 'MY_GH_TOKEN' },
      );

      expect(result).toEqual({
        kind: 'env',
        entries: [{ key: 'MY_GH_TOKEN', value: 'ghs_testtoken123' }],
      });
    });

    it('returns git-credential-helper exposure', () => {
      const result = githubAppPlugin.renderExposure(
        'git-credential-helper',
        secret,
        { kind: 'git-credential-helper' },
      );

      expect(result).toEqual({
        kind: 'git-credential-helper',
        host: 'github.com',
        protocol: 'https',
        username: 'x-access-token',
        password: 'ghs_testtoken123',
      });
    });

    it('throws for unsupported exposure kind', () => {
      expect(() =>
        githubAppPlugin.renderExposure(
          'localhost-proxy' as any,
          secret,
          { kind: 'localhost-proxy', port: 8080 } as any,
        ),
      ).toThrow('Unsupported exposure kind: localhost-proxy');
    });
  });

  describe('metadata', () => {
    it('has type "github-app"', () => {
      expect(githubAppPlugin.type).toBe('github-app');
    });

    it('supports env and git-credential-helper exposures', () => {
      expect(githubAppPlugin.supportedExposures).toEqual([
        'env',
        'git-credential-helper',
      ]);
    });
  });
});
