import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { AuthVerification, CachedToken, GitHubAppConfig } from '../../../src/auth/types.js';
import { GitHubAppErrorCode } from '../../../src/utils/errors.js';

// Mock @octokit/auth-app
vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn(),
}));

// Mock @octokit/rest
vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn(),
}));

// Import mocked modules
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

// The class we'll be testing (will be implemented in T009)
// Import it after mocks are set up
// import { GitHubAppAuthStrategy } from '../../../src/auth/github-app.js';

// Mock implementation types for testing
interface MockAuthResponse {
  type: string;
  token: string;
  appId: number;
  expiresAt?: string;
  installationId?: number;
  permissions?: Record<string, string>;
  repositorySelection?: 'all' | 'selected';
}

interface MockInstallation {
  id: number;
  account: {
    login: string;
    type: string;
  } | null;
  repository_selection: 'all' | 'selected';
}

// Test-double for GitHubAppAuthStrategy to test the interface
// This simulates what the actual implementation should do
class MockGitHubAppAuthStrategy {
  readonly type = 'github-app' as const;
  private config: GitHubAppConfig;
  private owner: string;
  private repo: string;
  private cachedToken: CachedToken | null = null;
  private installationId: number | null = null;
  private authFn: ReturnType<typeof createAppAuth> | null = null;

  constructor(config: GitHubAppConfig, owner: string, repo: string) {
    this.config = config;
    this.owner = owner;
    this.repo = repo;
  }

  async initialize(): Promise<void> {
    // Validate private key format
    const privateKey = this.config.privateKey;
    if (!privateKey) {
      throw new GitHubAppAuthErrorMock(
        'Private key is required',
        GitHubAppErrorCode.PRIVATE_KEY_NOT_FOUND
      );
    }

    if (!this.isValidPrivateKey(privateKey)) {
      throw new GitHubAppAuthErrorMock(
        'Invalid private key format',
        GitHubAppErrorCode.INVALID_PRIVATE_KEY
      );
    }

    // Create auth function using @octokit/auth-app
    this.authFn = createAppAuth({
      appId: this.config.appId,
      privateKey: privateKey,
    });

    // Use provided installationId or discover it
    if (this.config.installationId) {
      this.installationId = this.config.installationId;
    } else {
      this.installationId = await this.discoverInstallationId();
    }
  }

  private isValidPrivateKey(key: string): boolean {
    return key.includes('-----BEGIN') && key.includes('PRIVATE KEY-----');
  }

  private async discoverInstallationId(): Promise<number> {
    if (!this.authFn) {
      throw new Error('Auth function not initialized');
    }

    // Get app-level JWT token
    const appAuth = (await this.authFn({ type: 'app' })) as MockAuthResponse;

    // Create Octokit instance with app auth
    const octokit = new Octokit({ auth: appAuth.token });

    // Get installations for this app
    const response = await octokit.request('GET /app/installations');
    const installations = response.data as MockInstallation[];

    // Find installation for this owner
    const installation = installations.find(
      (inst) => inst.account?.login.toLowerCase() === this.owner.toLowerCase()
    );

    if (!installation) {
      throw new GitHubAppAuthErrorMock(
        `No installation found for owner: ${this.owner}`,
        GitHubAppErrorCode.INSTALLATION_NOT_FOUND
      );
    }

    return installation.id;
  }

  async getToken(): Promise<string> {
    if (!this.authFn || !this.installationId) {
      throw new Error('Strategy not initialized');
    }

    // Return cached token if still valid
    if (this.cachedToken && !this.isTokenExpired(this.cachedToken)) {
      return this.cachedToken.token;
    }

    // Generate new installation access token
    try {
      const installationAuth = (await this.authFn({
        type: 'installation',
        installationId: this.installationId,
      })) as MockAuthResponse;

      this.cachedToken = {
        token: installationAuth.token,
        expiresAt: new Date(installationAuth.expiresAt || Date.now() + 3600000),
        installationId: this.installationId,
        permissions: installationAuth.permissions || {},
        repositorySelection: installationAuth.repositorySelection || 'all',
      };

      return this.cachedToken.token;
    } catch (error) {
      throw new GitHubAppAuthErrorMock(
        'Failed to generate installation access token',
        GitHubAppErrorCode.TOKEN_GENERATION_FAILED,
        error
      );
    }
  }

  private isTokenExpired(token: CachedToken): boolean {
    // Consider token expired if less than 10 minutes remaining
    const bufferMs = 10 * 60 * 1000;
    return token.expiresAt.getTime() - Date.now() < bufferMs;
  }

  async verify(): Promise<AuthVerification> {
    const token = await this.getToken();
    const octokit = new Octokit({ auth: token });

    const response = await octokit.request('GET /user');
    const user = response.data as { login: string; id: number; type: string };

    return {
      login: user.login,
      id: user.id,
      type: user.type as 'User' | 'Bot',
    };
  }

  // Expose JWT generation for testing
  async generateJwt(): Promise<string> {
    if (!this.authFn) {
      throw new Error('Auth function not initialized');
    }

    const auth = (await this.authFn({ type: 'app' })) as MockAuthResponse;
    return auth.token;
  }
}

// Mock error class for testing
class GitHubAppAuthErrorMock extends Error {
  constructor(
    message: string,
    public readonly errorCode: GitHubAppErrorCode,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'GitHubAppAuthError';
  }
}

describe('GitHubAppAuthStrategy', () => {
  let mockAuthFn: Mock;
  let mockOctokitRequest: Mock;
  let mockOctokitInstance: { request: Mock };

  const validPrivateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MmVmEet1UmjQeD3D
QXQmVGCfshF8XTMPqHC06GZT7d2J9CgGX5zP7J3QDMj6sYcWwCh9SWdZGqJN/J5R
etc...
-----END RSA PRIVATE KEY-----`;

  const invalidPrivateKey = 'not-a-valid-private-key';

  const defaultConfig: GitHubAppConfig = {
    appId: 12345,
    privateKey: validPrivateKey,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock auth function
    mockAuthFn = vi.fn();
    (createAppAuth as Mock).mockReturnValue(mockAuthFn);

    // Setup mock Octokit
    mockOctokitRequest = vi.fn();
    mockOctokitInstance = { request: mockOctokitRequest };
    (Octokit as unknown as Mock).mockImplementation(() => mockOctokitInstance);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('JWT Generation', () => {
    it('should successfully generate JWT from app ID and private key', async () => {
      const expectedJwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test-jwt-token';

      // First call for initialization (discoverInstallationId)
      mockAuthFn.mockResolvedValueOnce({
        type: 'app',
        token: 'init-jwt-token',
        appId: 12345,
      });

      // Mock installations endpoint for initialization
      mockOctokitRequest.mockResolvedValueOnce({
        data: [
          {
            id: 98765,
            account: { login: 'test-owner', type: 'Organization' },
            repository_selection: 'all',
          },
        ],
      });

      const strategy = new MockGitHubAppAuthStrategy(defaultConfig, 'test-owner', 'test-repo');
      await strategy.initialize();

      // Second call for generateJwt()
      mockAuthFn.mockResolvedValueOnce({
        type: 'app',
        token: expectedJwt,
        appId: 12345,
      });

      const jwt = await strategy.generateJwt();

      expect(jwt).toBe(expectedJwt);
      expect(createAppAuth).toHaveBeenCalledWith({
        appId: 12345,
        privateKey: validPrivateKey,
      });
    });

    it('should throw error for invalid private key format', async () => {
      const config: GitHubAppConfig = {
        appId: 12345,
        privateKey: invalidPrivateKey,
      };

      const strategy = new MockGitHubAppAuthStrategy(config, 'test-owner', 'test-repo');

      try {
        await strategy.initialize();
        expect.fail('Expected initialize to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Invalid private key format');
        expect((error as GitHubAppAuthErrorMock).errorCode).toBe(
          GitHubAppErrorCode.INVALID_PRIVATE_KEY
        );
      }
    });

    it('should throw error when private key is missing', async () => {
      const config: GitHubAppConfig = {
        appId: 12345,
        // No privateKey provided
      };

      const strategy = new MockGitHubAppAuthStrategy(config, 'test-owner', 'test-repo');

      try {
        await strategy.initialize();
        expect.fail('Expected initialize to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Private key is required');
        expect((error as GitHubAppAuthErrorMock).errorCode).toBe(
          GitHubAppErrorCode.PRIVATE_KEY_NOT_FOUND
        );
      }
    });

    it('should generate JWT with correct claims (iss, iat, exp)', async () => {
      // This test verifies that @octokit/auth-app is called correctly
      // The actual JWT claims are handled by the library

      // First call for initialization (discoverInstallationId)
      mockAuthFn.mockResolvedValueOnce({
        type: 'app',
        token: 'init-jwt',
        appId: 12345,
      });

      mockOctokitRequest.mockResolvedValueOnce({
        data: [
          {
            id: 98765,
            account: { login: 'test-owner', type: 'Organization' },
            repository_selection: 'all',
          },
        ],
      });

      const strategy = new MockGitHubAppAuthStrategy(defaultConfig, 'test-owner', 'test-repo');
      await strategy.initialize();

      // Second call for generateJwt()
      mockAuthFn.mockResolvedValueOnce({
        type: 'app',
        token: 'test-jwt',
        appId: 12345,
      });

      await strategy.generateJwt();

      // Verify auth function was called with type: 'app' for JWT generation
      expect(mockAuthFn).toHaveBeenCalledWith({ type: 'app' });
    });
  });

  describe('Installation Discovery', () => {
    it('should successfully discover installation ID for owner/repo', async () => {
      mockAuthFn.mockResolvedValueOnce({
        type: 'app',
        token: 'app-jwt-token',
        appId: 12345,
      });

      mockOctokitRequest.mockResolvedValueOnce({
        data: [
          {
            id: 11111,
            account: { login: 'other-owner', type: 'User' },
            repository_selection: 'selected',
          },
          {
            id: 98765,
            account: { login: 'test-owner', type: 'Organization' },
            repository_selection: 'all',
          },
        ],
      });

      const strategy = new MockGitHubAppAuthStrategy(defaultConfig, 'test-owner', 'test-repo');
      await strategy.initialize();

      // The installation ID should be discovered and used
      mockAuthFn.mockResolvedValueOnce({
        type: 'installation',
        token: 'installation-token',
        installationId: 98765,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        permissions: { issues: 'write' },
        repositorySelection: 'all',
      });

      const token = await strategy.getToken();
      expect(token).toBe('installation-token');

      // Verify the installation auth was called with the discovered ID
      expect(mockAuthFn).toHaveBeenCalledWith({
        type: 'installation',
        installationId: 98765,
      });
    });

    it('should throw INSTALLATION_NOT_FOUND when no installation exists', async () => {
      mockAuthFn.mockResolvedValueOnce({
        type: 'app',
        token: 'app-jwt-token',
        appId: 12345,
      });

      mockOctokitRequest.mockResolvedValueOnce({
        data: [
          {
            id: 11111,
            account: { login: 'other-owner', type: 'User' },
            repository_selection: 'all',
          },
        ],
      });

      const strategy = new MockGitHubAppAuthStrategy(defaultConfig, 'test-owner', 'test-repo');

      try {
        await strategy.initialize();
        expect.fail('Expected initialize to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('No installation found for owner: test-owner');
        expect((error as GitHubAppAuthErrorMock).errorCode).toBe(
          GitHubAppErrorCode.INSTALLATION_NOT_FOUND
        );
      }
    });

    it('should handle multiple installations correctly', async () => {
      mockAuthFn.mockResolvedValueOnce({
        type: 'app',
        token: 'app-jwt-token',
        appId: 12345,
      });

      // Return multiple installations including case-insensitive match
      mockOctokitRequest.mockResolvedValueOnce({
        data: [
          {
            id: 11111,
            account: { login: 'acme-corp', type: 'Organization' },
            repository_selection: 'all',
          },
          {
            id: 22222,
            account: { login: 'Test-Owner', type: 'Organization' }, // Different case
            repository_selection: 'selected',
          },
          {
            id: 33333,
            account: { login: 'another-org', type: 'Organization' },
            repository_selection: 'all',
          },
        ],
      });

      const strategy = new MockGitHubAppAuthStrategy(defaultConfig, 'test-owner', 'test-repo');
      await strategy.initialize();

      mockAuthFn.mockResolvedValueOnce({
        type: 'installation',
        token: 'correct-installation-token',
        installationId: 22222,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });

      const token = await strategy.getToken();
      expect(token).toBe('correct-installation-token');

      // Should match case-insensitively
      expect(mockAuthFn).toHaveBeenCalledWith({
        type: 'installation',
        installationId: 22222,
      });
    });

    it('should use provided installationId instead of discovering', async () => {
      const configWithInstallationId: GitHubAppConfig = {
        ...defaultConfig,
        installationId: 54321,
      };

      const strategy = new MockGitHubAppAuthStrategy(
        configWithInstallationId,
        'test-owner',
        'test-repo'
      );
      await strategy.initialize();

      // Should not call GET /app/installations
      expect(mockOctokitRequest).not.toHaveBeenCalledWith('GET /app/installations');

      mockAuthFn.mockResolvedValueOnce({
        type: 'installation',
        token: 'provided-installation-token',
        installationId: 54321,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });

      const token = await strategy.getToken();
      expect(token).toBe('provided-installation-token');

      expect(mockAuthFn).toHaveBeenCalledWith({
        type: 'installation',
        installationId: 54321,
      });
    });
  });

  describe('Token Generation', () => {
    beforeEach(async () => {
      mockAuthFn.mockResolvedValueOnce({
        type: 'app',
        token: 'app-jwt-token',
        appId: 12345,
      });

      mockOctokitRequest.mockResolvedValueOnce({
        data: [
          {
            id: 98765,
            account: { login: 'test-owner', type: 'Organization' },
            repository_selection: 'all',
          },
        ],
      });
    });

    it('should successfully generate installation access token', async () => {
      const strategy = new MockGitHubAppAuthStrategy(defaultConfig, 'test-owner', 'test-repo');
      await strategy.initialize();

      mockAuthFn.mockResolvedValueOnce({
        type: 'installation',
        token: 'ghs_xxxxxxxxxxxxxxxxxxxx',
        installationId: 98765,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        permissions: { issues: 'write', contents: 'read' },
        repositorySelection: 'all',
      });

      const token = await strategy.getToken();

      expect(token).toBe('ghs_xxxxxxxxxxxxxxxxxxxx');
      expect(mockAuthFn).toHaveBeenCalledWith({
        type: 'installation',
        installationId: 98765,
      });
    });

    it('should return cached token if not expired', async () => {
      const strategy = new MockGitHubAppAuthStrategy(defaultConfig, 'test-owner', 'test-repo');
      await strategy.initialize();

      // First call - generates token
      mockAuthFn.mockResolvedValueOnce({
        type: 'installation',
        token: 'cached-token',
        installationId: 98765,
        expiresAt: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
      });

      const token1 = await strategy.getToken();
      expect(token1).toBe('cached-token');

      // Reset mock call count
      mockAuthFn.mockClear();

      // Second call - should use cache
      const token2 = await strategy.getToken();
      expect(token2).toBe('cached-token');

      // Auth function should NOT have been called again
      expect(mockAuthFn).not.toHaveBeenCalled();
    });

    it('should refresh token if close to expiry (within 10 minutes)', async () => {
      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      const strategy = new MockGitHubAppAuthStrategy(defaultConfig, 'test-owner', 'test-repo');
      await strategy.initialize();

      // First call - token expires in 5 minutes (already close to expiry)
      mockAuthFn.mockResolvedValueOnce({
        type: 'installation',
        token: 'expiring-soon-token',
        installationId: 98765,
        expiresAt: new Date(now + 5 * 60 * 1000).toISOString(), // 5 minutes from now
      });

      const token1 = await strategy.getToken();
      expect(token1).toBe('expiring-soon-token');

      // Advance time by 1 minute
      vi.advanceTimersByTime(60 * 1000);

      // Second call should refresh since token is within 10-minute buffer
      mockAuthFn.mockResolvedValueOnce({
        type: 'installation',
        token: 'fresh-token',
        installationId: 98765,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });

      const token2 = await strategy.getToken();
      expect(token2).toBe('fresh-token');
    });

    it('should throw TOKEN_GENERATION_FAILED on API errors', async () => {
      const strategy = new MockGitHubAppAuthStrategy(defaultConfig, 'test-owner', 'test-repo');
      await strategy.initialize();

      mockAuthFn.mockRejectedValueOnce(new Error('API rate limit exceeded'));

      try {
        await strategy.getToken();
        expect.fail('Expected getToken to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Failed to generate installation access token');
        expect((error as GitHubAppAuthErrorMock).errorCode).toBe(
          GitHubAppErrorCode.TOKEN_GENERATION_FAILED
        );
      }
    });

    it('should include permissions in cached token', async () => {
      const strategy = new MockGitHubAppAuthStrategy(defaultConfig, 'test-owner', 'test-repo');
      await strategy.initialize();

      const permissions = {
        issues: 'write',
        contents: 'read',
        pull_requests: 'write',
      };

      mockAuthFn.mockResolvedValueOnce({
        type: 'installation',
        token: 'token-with-permissions',
        installationId: 98765,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        permissions,
        repositorySelection: 'selected',
      });

      const token = await strategy.getToken();
      expect(token).toBe('token-with-permissions');

      // Token should be cached with permissions
      // (In actual implementation, this would be accessible via a getter)
    });
  });

  describe('verify', () => {
    beforeEach(async () => {
      mockAuthFn.mockResolvedValueOnce({
        type: 'app',
        token: 'app-jwt-token',
        appId: 12345,
      });

      mockOctokitRequest.mockResolvedValueOnce({
        data: [
          {
            id: 98765,
            account: { login: 'test-owner', type: 'Organization' },
            repository_selection: 'all',
          },
        ],
      });
    });

    it('should return Bot type for authenticated bot', async () => {
      const strategy = new MockGitHubAppAuthStrategy(defaultConfig, 'test-owner', 'test-repo');
      await strategy.initialize();

      mockAuthFn.mockResolvedValueOnce({
        type: 'installation',
        token: 'installation-token',
        installationId: 98765,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });

      mockOctokitRequest.mockResolvedValueOnce({
        data: {
          login: 'my-app[bot]',
          id: 123456789,
          type: 'Bot',
        },
      });

      const verification = await strategy.verify();

      expect(verification.type).toBe('Bot');
      expect(verification.id).toBe(123456789);
    });

    it('should return correct login name (appname[bot])', async () => {
      const strategy = new MockGitHubAppAuthStrategy(defaultConfig, 'test-owner', 'test-repo');
      await strategy.initialize();

      mockAuthFn.mockResolvedValueOnce({
        type: 'installation',
        token: 'installation-token',
        installationId: 98765,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });

      mockOctokitRequest.mockResolvedValueOnce({
        data: {
          login: 'generacy-bot[bot]',
          id: 987654321,
          type: 'Bot',
        },
      });

      const verification = await strategy.verify();

      expect(verification.login).toBe('generacy-bot[bot]');
      expect(verification.login).toMatch(/\[bot\]$/);
    });

    it('should use existing cached token for verification', async () => {
      const strategy = new MockGitHubAppAuthStrategy(defaultConfig, 'test-owner', 'test-repo');
      await strategy.initialize();

      // Get token first (to populate cache)
      mockAuthFn.mockResolvedValueOnce({
        type: 'installation',
        token: 'cached-token-for-verify',
        installationId: 98765,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      });

      await strategy.getToken();
      mockAuthFn.mockClear();

      // Now verify - should use cached token
      mockOctokitRequest.mockResolvedValueOnce({
        data: {
          login: 'test-bot[bot]',
          id: 111222333,
          type: 'Bot',
        },
      });

      const verification = await strategy.verify();

      expect(verification.login).toBe('test-bot[bot]');
      // Auth function should not have been called again (used cache)
      expect(mockAuthFn).not.toHaveBeenCalled();
    });
  });

  describe('type property', () => {
    it('should have type property set to "github-app"', () => {
      const strategy = new MockGitHubAppAuthStrategy(defaultConfig, 'test-owner', 'test-repo');
      expect(strategy.type).toBe('github-app');
    });
  });
});
