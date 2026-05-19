import { awsStsPlugin } from '../../src/plugins/core/aws-sts.js';
import type { MintContext, BackendClient, ExposureKind } from '@generacy-ai/credhelper';

const stsXmlResponse = [
  '<AssumeRoleResponse>',
  '<AssumeRoleResult>',
  '<Credentials>',
  '<AccessKeyId>ASIATESTACCESSKEY</AccessKeyId>',
  '<SecretAccessKey>testsecretkey123</SecretAccessKey>',
  '<SessionToken>testsessiontoken456</SessionToken>',
  '<Expiration>2026-01-01T00:00:00Z</Expiration>',
  '</Credentials>',
  '</AssumeRoleResult>',
  '</AssumeRoleResponse>',
].join('');

const baseCreds = JSON.stringify({
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});

const baseCredsWithToken = JSON.stringify({
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  sessionToken: 'existingSessionToken',
});

describe('awsStsPlugin', () => {
  describe('credentialSchema', () => {
    it('accepts valid config with roleArn', () => {
      const result = awsStsPlugin.credentialSchema.safeParse({
        roleArn: 'arn:aws:iam::123456789012:role/MyRole',
      });
      expect(result.success).toBe(true);
    });

    it('accepts config with externalId and region', () => {
      const result = awsStsPlugin.credentialSchema.safeParse({
        roleArn: 'arn:aws:iam::123456789012:role/MyRole',
        externalId: 'ext-123',
        region: 'eu-west-1',
      });
      expect(result.success).toBe(true);
    });

    it('rejects invalid roleArn format', () => {
      const result = awsStsPlugin.credentialSchema.safeParse({
        roleArn: 'not-a-valid-arn',
      });
      expect(result.success).toBe(false);
    });

    it('rejects missing roleArn', () => {
      const result = awsStsPlugin.credentialSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('rejects roleArn with wrong account ID length', () => {
      const result = awsStsPlugin.credentialSchema.safeParse({
        roleArn: 'arn:aws:iam::12345:role/MyRole',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('scopeSchema', () => {
    it('accepts durationSeconds within range', () => {
      const result = awsStsPlugin.scopeSchema!.safeParse({
        durationSeconds: 3600,
      });
      expect(result.success).toBe(true);
    });

    it('accepts sessionPolicy', () => {
      const result = awsStsPlugin.scopeSchema!.safeParse({
        sessionPolicy: { Version: '2012-10-17', Statement: [] },
      });
      expect(result.success).toBe(true);
    });

    it('accepts empty object', () => {
      const result = awsStsPlugin.scopeSchema!.safeParse({});
      expect(result.success).toBe(true);
    });

    it('rejects durationSeconds below 900', () => {
      const result = awsStsPlugin.scopeSchema!.safeParse({
        durationSeconds: 899,
      });
      expect(result.success).toBe(false);
    });

    it('rejects durationSeconds above 43200', () => {
      const result = awsStsPlugin.scopeSchema!.safeParse({
        durationSeconds: 43201,
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer durationSeconds', () => {
      const result = awsStsPlugin.scopeSchema!.safeParse({
        durationSeconds: 3600.5,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('mint()', () => {
    let mockBackend: BackendClient;

    beforeEach(() => {
      mockBackend = {
        fetchSecret: vi.fn().mockResolvedValue(baseCreds),
      };
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns assumed role credentials and expiration on success', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(stsXmlResponse),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'aws-cred',
        backendKey: 'aws-base-key',
        backend: mockBackend,
        scope: {},
        ttl: 3600,
        config: { roleArn: 'arn:aws:iam::123456789012:role/MyRole' },
      };

      const result = await awsStsPlugin.mint!(ctx);

      expect(result.value).toEqual({
        value: JSON.stringify({
          accessKeyId: 'ASIATESTACCESSKEY',
          secretAccessKey: 'testsecretkey123',
          sessionToken: 'testsessiontoken456',
        }),
        format: 'json',
      });
      expect(result.expiresAt).toEqual(new Date('2026-01-01T00:00:00Z'));
    });

    it('calls fetchSecret with the backendKey', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(stsXmlResponse),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'aws-cred',
        backendKey: 'my-aws-secret',
        backend: mockBackend,
        scope: {},
        ttl: 3600,
        config: { roleArn: 'arn:aws:iam::123456789012:role/MyRole' },
      };

      await awsStsPlugin.mint!(ctx);

      expect(mockBackend.fetchSecret).toHaveBeenCalledWith('my-aws-secret');
    });

    it('calls the correct STS endpoint with default region', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(stsXmlResponse),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'aws-cred',
        backendKey: 'key',
        backend: mockBackend,
        scope: {},
        ttl: 3600,
        config: { roleArn: 'arn:aws:iam::123456789012:role/MyRole' },
      };

      await awsStsPlugin.mint!(ctx);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://sts.us-east-1.amazonaws.com/',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('uses the configured region for STS endpoint', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(stsXmlResponse),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'aws-cred',
        backendKey: 'key',
        backend: mockBackend,
        scope: {},
        ttl: 3600,
        config: {
          roleArn: 'arn:aws:iam::123456789012:role/MyRole',
          region: 'eu-west-1',
        },
      };

      await awsStsPlugin.mint!(ctx);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://sts.eu-west-1.amazonaws.com/',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('includes ExternalId in request body when configured', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(stsXmlResponse),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'aws-cred',
        backendKey: 'key',
        backend: mockBackend,
        scope: {},
        ttl: 3600,
        config: {
          roleArn: 'arn:aws:iam::123456789012:role/MyRole',
          externalId: 'ext-abc',
        },
      };

      await awsStsPlugin.mint!(ctx);

      const callBody = fetchSpy.mock.calls[0]![1]!.body as string;
      expect(callBody).toContain('ExternalId=ext-abc');
    });

    it('includes DurationSeconds when specified in scope', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(stsXmlResponse),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'aws-cred',
        backendKey: 'key',
        backend: mockBackend,
        scope: { durationSeconds: 7200 },
        ttl: 3600,
        config: { roleArn: 'arn:aws:iam::123456789012:role/MyRole' },
      };

      await awsStsPlugin.mint!(ctx);

      const callBody = fetchSpy.mock.calls[0]![1]!.body as string;
      expect(callBody).toContain('DurationSeconds=7200');
    });

    it('includes session policy when specified in scope', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(stsXmlResponse),
      } as Response);

      const policy = { Version: '2012-10-17', Statement: [] };
      const ctx: MintContext = {
        credentialId: 'aws-cred',
        backendKey: 'key',
        backend: mockBackend,
        scope: { sessionPolicy: policy },
        ttl: 3600,
        config: { roleArn: 'arn:aws:iam::123456789012:role/MyRole' },
      };

      await awsStsPlugin.mint!(ctx);

      const callBody = fetchSpy.mock.calls[0]![1]!.body as string;
      const params = new URLSearchParams(callBody);
      expect(params.get('Policy')).toBe(JSON.stringify(policy));
    });

    it('includes x-amz-security-token header when base creds have sessionToken', async () => {
      const backendWithToken: BackendClient = {
        fetchSecret: vi.fn().mockResolvedValue(baseCredsWithToken),
      };

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(stsXmlResponse),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'aws-cred',
        backendKey: 'key',
        backend: backendWithToken,
        scope: {},
        ttl: 3600,
        config: { roleArn: 'arn:aws:iam::123456789012:role/MyRole' },
      };

      await awsStsPlugin.mint!(ctx);

      const callHeaders = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(callHeaders['x-amz-security-token']).toBe('existingSessionToken');
    });

    it('sends SigV4 Authorization header', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(stsXmlResponse),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'aws-cred',
        backendKey: 'key',
        backend: mockBackend,
        scope: {},
        ttl: 3600,
        config: { roleArn: 'arn:aws:iam::123456789012:role/MyRole' },
      };

      await awsStsPlugin.mint!(ctx);

      const callHeaders = fetchSpy.mock.calls[0]![1]!.headers as Record<string, string>;
      expect(callHeaders['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
      expect(callHeaders['authorization']).toContain('SignedHeaders=');
      expect(callHeaders['authorization']).toContain('Signature=');
    });

    it('throws on non-ok STS response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 403,
        text: () => Promise.resolve('<ErrorResponse><Error><Code>AccessDenied</Code></Error></ErrorResponse>'),
      } as unknown as Response);

      const ctx: MintContext = {
        credentialId: 'aws-cred',
        backendKey: 'key',
        backend: mockBackend,
        scope: {},
        ttl: 3600,
        config: { roleArn: 'arn:aws:iam::123456789012:role/MyRole' },
      };

      await expect(awsStsPlugin.mint!(ctx)).rejects.toThrow(
        'AWS STS error (403):',
      );
    });

    it('sends request body with Action=AssumeRole and RoleArn', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(stsXmlResponse),
      } as Response);

      const ctx: MintContext = {
        credentialId: 'aws-cred',
        backendKey: 'key',
        backend: mockBackend,
        scope: {},
        ttl: 3600,
        config: { roleArn: 'arn:aws:iam::123456789012:role/MyRole' },
      };

      await awsStsPlugin.mint!(ctx);

      const callBody = fetchSpy.mock.calls[0]![1]!.body as string;
      const params = new URLSearchParams(callBody);
      expect(params.get('Action')).toBe('AssumeRole');
      expect(params.get('Version')).toBe('2011-06-15');
      expect(params.get('RoleArn')).toBe('arn:aws:iam::123456789012:role/MyRole');
      expect(params.get('RoleSessionName')).toMatch(/^credhelper-\d+$/);
    });
  });

  describe('renderExposure()', () => {
    const secret = {
      value: JSON.stringify({
        accessKeyId: 'ASIATESTACCESSKEY',
        secretAccessKey: 'testsecretkey123',
        sessionToken: 'testsessiontoken456',
      }),
      format: 'json' as const,
    };

    it('returns env exposure with three AWS entries', () => {
      const result = awsStsPlugin.renderExposure(
        'env' as ExposureKind,
        secret,
        { kind: 'env', name: 'AWS_ACCESS_KEY_ID' },
      );

      expect(result).toEqual({
        kind: 'env',
        entries: [
          { key: 'AWS_ACCESS_KEY_ID', value: 'ASIATESTACCESSKEY' },
          { key: 'AWS_SECRET_ACCESS_KEY', value: 'testsecretkey123' },
          { key: 'AWS_SESSION_TOKEN', value: 'testsessiontoken456' },
        ],
      });
    });

    it('throws for unsupported exposure kind', () => {
      expect(() =>
        awsStsPlugin.renderExposure(
          'localhost-proxy' as ExposureKind,
          secret,
          { kind: 'localhost-proxy', port: 8080 },
        ),
      ).toThrow('Unsupported exposure kind: localhost-proxy');
    });
  });

  describe('metadata', () => {
    it('has type "aws-sts"', () => {
      expect(awsStsPlugin.type).toBe('aws-sts');
    });

    it('supports only env exposure', () => {
      expect(awsStsPlugin.supportedExposures).toEqual(['env']);
    });

    it('has a scopeSchema defined', () => {
      expect(awsStsPlugin.scopeSchema).toBeDefined();
    });
  });
});
