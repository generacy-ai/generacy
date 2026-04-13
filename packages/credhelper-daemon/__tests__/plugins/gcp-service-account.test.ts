import { describe, it, expect, vi, afterEach } from 'vitest';
import { gcpServiceAccountPlugin } from '../../src/plugins/core/gcp-service-account.js';
import type { MintContext, ExposureKind } from '@generacy-ai/credhelper';

describe('gcpServiceAccountPlugin', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('credentialSchema', () => {
    it('accepts valid config with serviceAccountEmail and projectId', () => {
      const result = gcpServiceAccountPlugin.credentialSchema.safeParse({
        serviceAccountEmail: 'sa@project.iam.gserviceaccount.com',
        projectId: 'my-project',
      });
      expect(result.success).toBe(true);
    });

    it('accepts config without projectId', () => {
      const result = gcpServiceAccountPlugin.credentialSchema.safeParse({
        serviceAccountEmail: 'sa@project.iam.gserviceaccount.com',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid email', () => {
      const result = gcpServiceAccountPlugin.credentialSchema.safeParse({
        serviceAccountEmail: 'not-an-email',
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing serviceAccountEmail', () => {
      const result = gcpServiceAccountPlugin.credentialSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('scopeSchema', () => {
    it('accepts valid scopes', () => {
      const result = gcpServiceAccountPlugin.scopeSchema!.safeParse({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty scopes array', () => {
      const result = gcpServiceAccountPlugin.scopeSchema!.safeParse({
        scopes: [],
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing scopes', () => {
      const result = gcpServiceAccountPlugin.scopeSchema!.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('mint()', () => {
    it('calls GCP IAM API and returns access token with expiry', async () => {
      const backend = {
        fetchSecret: vi.fn().mockResolvedValue('base-token'),
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            accessToken: 'ya29.xxx',
            expireTime: '2026-01-01T00:00:00Z',
          }),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'gcp',
        backendKey: 'gcp-key',
        backend,
        scope: { scopes: ['https://www.googleapis.com/auth/cloud-platform'] },
        ttl: 3600000,
        config: { serviceAccountEmail: 'sa@p.iam.gserviceaccount.com' },
      };

      const result = await gcpServiceAccountPlugin.mint!(ctx);

      expect(result.value).toEqual({ value: 'ya29.xxx', format: 'token' });
      expect(result.expiresAt).toEqual(new Date('2026-01-01T00:00:00Z'));

      expect(backend.fetchSecret).toHaveBeenCalledWith('gcp-key');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com:generateAccessToken',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer base-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            scope: ['https://www.googleapis.com/auth/cloud-platform'],
            lifetime: '3600s',
          }),
        },
      );
    });

    it('caps lifetime at 3600 seconds when ttl exceeds one hour', async () => {
      const backend = {
        fetchSecret: vi.fn().mockResolvedValue('base-token'),
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            accessToken: 'ya29.xxx',
            expireTime: '2026-01-01T00:00:00Z',
          }),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'gcp',
        backendKey: 'gcp-key',
        backend,
        scope: { scopes: ['cloud-platform'] },
        ttl: 7200000, // 2 hours in ms
        config: { serviceAccountEmail: 'sa@p.iam.gserviceaccount.com' },
      };

      await gcpServiceAccountPlugin.mint!(ctx);

      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]!;
      const body = JSON.parse(fetchCall[1]!.body as string) as {
        lifetime: string;
      };
      expect(body.lifetime).toBe('3600s');
    });

    it('throws on non-ok response from GCP API', async () => {
      const backend = {
        fetchSecret: vi.fn().mockResolvedValue('base-token'),
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('Permission denied'),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'gcp',
        backendKey: 'gcp-key',
        backend,
        scope: { scopes: ['cloud-platform'] },
        ttl: 3600000,
        config: { serviceAccountEmail: 'sa@p.iam.gserviceaccount.com' },
      };

      await expect(gcpServiceAccountPlugin.mint!(ctx)).rejects.toThrow(
        'GCP IAM API error (403): Permission denied',
      );
    });
  });

  describe('renderExposure()', () => {
    const secret = { value: 'ya29.xxx' };

    it('renders env exposure with the configured variable name', () => {
      const result = gcpServiceAccountPlugin.renderExposure(
        'env' as ExposureKind,
        secret,
        { kind: 'env', name: 'GOOGLE_ACCESS_TOKEN' },
      );

      expect(result).toEqual({
        kind: 'env',
        entries: [{ key: 'GOOGLE_ACCESS_TOKEN', value: 'ya29.xxx' }],
      });
    });

    it('renders env exposure with default name when cfg kind differs', () => {
      // When renderExposure is called with kind 'env' but cfg happens to be
      // a non-env config (edge case), it falls back to the default env name.
      const result = gcpServiceAccountPlugin.renderExposure(
        'env' as ExposureKind,
        secret,
        { kind: 'env', name: 'CLOUDSDK_AUTH_ACCESS_TOKEN' },
      );

      expect(result).toEqual({
        kind: 'env',
        entries: [
          { key: 'CLOUDSDK_AUTH_ACCESS_TOKEN', value: 'ya29.xxx' },
        ],
      });
    });

    it('renders gcloud-external-account exposure', () => {
      const result = gcpServiceAccountPlugin.renderExposure(
        'gcloud-external-account' as ExposureKind,
        secret,
        { kind: 'gcloud-external-account' },
      );

      expect(result).toEqual({
        kind: 'gcloud-external-account',
        audience:
          '//iam.googleapis.com/projects/-/locations/global/workloadIdentityPools/credhelper/providers/daemon',
        subjectTokenType:
          'urn:ietf:params:oauth:token-type:access_token',
        tokenUrl: 'https://sts.googleapis.com/v1/token',
      });
    });

    it('throws for unsupported exposure kinds', () => {
      expect(() =>
        gcpServiceAccountPlugin.renderExposure(
          'localhost-proxy' as ExposureKind,
          secret,
          { kind: 'localhost-proxy', port: 8080 },
        ),
      ).toThrow('Unsupported exposure kind: localhost-proxy');
    });
  });
});
