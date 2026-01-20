import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AuthStrategy, GitHubAppConfig } from '../../../src/auth/types.js';

// Mock the GitHubAppAuthStrategy class from github-app.ts
vi.mock('../../../src/auth/github-app.js', () => {
  const mockStrategy = {
    type: 'github-app' as const,
    getToken: vi.fn().mockResolvedValue('ghs_mock_token'),
    verify: vi.fn().mockResolvedValue({
      login: 'my-app[bot]',
      id: 12345,
      type: 'Bot',
    }),
    initialize: vi.fn().mockResolvedValue(undefined),
  };

  return {
    GitHubAppAuthStrategy: vi.fn(() => mockStrategy),
  };
});

// Import after mocks are set up
import { createAuthStrategy, PATAuthStrategy } from '../../../src/auth/auth-factory.js';
import { GitHubAppAuthStrategy } from '../../../src/auth/github-app.js';

describe('createAuthStrategy', () => {
  const baseConfig = {
    owner: 'test-owner',
    repo: 'test-repo',
  };

  const validAppConfig: GitHubAppConfig = {
    appId: 123456,
    privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMOCK_KEY\n-----END RSA PRIVATE KEY-----',
  };

  const validAppConfigWithPath: GitHubAppConfig = {
    appId: 123456,
    privateKeyPath: '/path/to/private-key.pem',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset console mocks
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Strategy Selection', () => {
    it('should return GitHubAppAuthStrategy when app config is provided', async () => {
      const result = await createAuthStrategy({
        ...baseConfig,
        app: validAppConfig,
      });

      expect(result.type).toBe('github-app');
      expect(GitHubAppAuthStrategy).toHaveBeenCalledOnce();
    });

    it('should return PATAuthStrategy when only token is provided', async () => {
      const result = await createAuthStrategy({
        ...baseConfig,
        token: 'ghp_test_token',
      });

      expect(result.type).toBe('pat');
      expect(result).toBeInstanceOf(PATAuthStrategy);
    });

    it('should prefer GitHub App auth when both app and token are configured', async () => {
      const result = await createAuthStrategy({
        ...baseConfig,
        app: validAppConfig,
        token: 'ghp_test_token',
      });

      expect(result.type).toBe('github-app');
      expect(GitHubAppAuthStrategy).toHaveBeenCalledOnce();
    });

    it('should throw error when neither app nor token is configured', async () => {
      await expect(createAuthStrategy(baseConfig)).rejects.toThrow(
        /no authentication configured|authentication required/i
      );
    });
  });

  describe('GitHub App Config Validation', () => {
    it('should accept config with privateKey (inline)', async () => {
      const result = await createAuthStrategy({
        ...baseConfig,
        app: validAppConfig,
      });

      expect(result.type).toBe('github-app');
      expect(GitHubAppAuthStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 123456,
          privateKey: expect.stringContaining('BEGIN RSA PRIVATE KEY'),
        }),
        expect.anything()
      );
    });

    it('should accept config with privateKeyPath (file path)', async () => {
      const result = await createAuthStrategy({
        ...baseConfig,
        app: validAppConfigWithPath,
      });

      expect(result.type).toBe('github-app');
      expect(GitHubAppAuthStrategy).toHaveBeenCalledWith(
        expect.objectContaining({
          appId: 123456,
          privateKeyPath: '/path/to/private-key.pem',
        }),
        expect.anything()
      );
    });

    it('should throw error when neither privateKey nor privateKeyPath provided', async () => {
      const invalidConfig: GitHubAppConfig = {
        appId: 123456,
        // No privateKey or privateKeyPath
      };

      await expect(
        createAuthStrategy({
          ...baseConfig,
          app: invalidConfig,
        })
      ).rejects.toThrow(/privateKey|privateKeyPath/i);
    });

    it('should validate appId is present', async () => {
      const invalidConfig = {
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMOCK_KEY\n-----END RSA PRIVATE KEY-----',
        // No appId
      } as GitHubAppConfig;

      await expect(
        createAuthStrategy({
          ...baseConfig,
          app: invalidConfig,
        })
      ).rejects.toThrow(/appId/i);
    });
  });

  describe('PAT Fallback', () => {
    it('should fall back to PAT when GitHub App auth initialization fails', async () => {
      // Make the mock throw on initialize
      vi.mocked(GitHubAppAuthStrategy).mockImplementationOnce(() => {
        const mockWithError = {
          type: 'github-app' as const,
          getToken: vi.fn(),
          verify: vi.fn(),
          initialize: vi.fn().mockRejectedValue(new Error('Failed to initialize')),
        };
        return mockWithError as unknown as InstanceType<typeof GitHubAppAuthStrategy>;
      });

      const result = await createAuthStrategy({
        ...baseConfig,
        app: validAppConfig,
        token: 'ghp_fallback_token',
      });

      expect(result.type).toBe('pat');
      expect(result).toBeInstanceOf(PATAuthStrategy);
    });

    it('should log warning when using fallback', async () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn');

      vi.mocked(GitHubAppAuthStrategy).mockImplementationOnce(() => {
        const mockWithError = {
          type: 'github-app' as const,
          getToken: vi.fn(),
          verify: vi.fn(),
          initialize: vi.fn().mockRejectedValue(new Error('Failed to initialize')),
        };
        return mockWithError as unknown as InstanceType<typeof GitHubAppAuthStrategy>;
      });

      await createAuthStrategy({
        ...baseConfig,
        app: validAppConfig,
        token: 'ghp_fallback_token',
      });

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/fallback|failed|pat/i)
      );
    });

    it('should throw if no fallback available', async () => {
      vi.mocked(GitHubAppAuthStrategy).mockImplementationOnce(() => {
        const mockWithError = {
          type: 'github-app' as const,
          getToken: vi.fn(),
          verify: vi.fn(),
          initialize: vi.fn().mockRejectedValue(new Error('Failed to initialize')),
        };
        return mockWithError as unknown as InstanceType<typeof GitHubAppAuthStrategy>;
      });

      await expect(
        createAuthStrategy({
          ...baseConfig,
          app: validAppConfig,
          // No token for fallback
        })
      ).rejects.toThrow(/failed|initialize/i);
    });
  });

  describe('Strategy Type', () => {
    it('should return strategy with type "github-app" for GitHub App auth', async () => {
      const result = await createAuthStrategy({
        ...baseConfig,
        app: validAppConfig,
      });

      expect(result.type).toBe('github-app');
    });

    it('should return strategy with type "pat" for PAT auth', async () => {
      const result = await createAuthStrategy({
        ...baseConfig,
        token: 'ghp_test_token',
      });

      expect(result.type).toBe('pat');
    });
  });

  describe('BaseUrl Configuration', () => {
    it('should pass baseUrl to GitHubAppAuthStrategy when provided', async () => {
      await createAuthStrategy({
        ...baseConfig,
        app: validAppConfig,
        baseUrl: 'https://github.example.com/api/v3',
      });

      expect(GitHubAppAuthStrategy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          baseUrl: 'https://github.example.com/api/v3',
        })
      );
    });

    it('should pass baseUrl to PATAuthStrategy when provided', async () => {
      const result = await createAuthStrategy({
        ...baseConfig,
        token: 'ghp_test_token',
        baseUrl: 'https://github.example.com/api/v3',
      });

      expect(result.type).toBe('pat');
      // The PATAuthStrategy is constructed internally - just verify it returns correct type
    });
  });

  describe('Owner and Repo Configuration', () => {
    it('should pass owner and repo to GitHubAppAuthStrategy', async () => {
      await createAuthStrategy({
        owner: 'my-org',
        repo: 'my-repo',
        app: validAppConfig,
      });

      expect(GitHubAppAuthStrategy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          owner: 'my-org',
          repo: 'my-repo',
        })
      );
    });

    it('should pass owner and repo to PATAuthStrategy', async () => {
      const result = await createAuthStrategy({
        owner: 'my-org',
        repo: 'my-repo',
        token: 'ghp_test_token',
      });

      expect(result.type).toBe('pat');
      // The PATAuthStrategy is constructed internally - just verify it returns correct type
    });
  });
});
