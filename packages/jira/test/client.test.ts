import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JiraClient, createClient, createClientAsync } from '../src/client.js';
import {
  JiraAuthError,
  JiraValidationError,
  JiraConnectionError,
} from '../src/utils/errors.js';

// Mock jira.js
vi.mock('jira.js', () => ({
  Version3Client: vi.fn().mockImplementation(() => ({
    myself: {
      getCurrentUser: vi.fn().mockResolvedValue({
        accountId: 'test-account-id',
        displayName: 'Test User',
        emailAddress: 'test@example.com',
      }),
    },
    serverInfo: {
      getServerInfo: vi.fn().mockResolvedValue({
        version: '1001.0.0-SNAPSHOT',
        baseUrl: 'https://test.atlassian.net',
      }),
    },
  })),
  AgileClient: vi.fn().mockImplementation(() => ({})),
}));

describe('JiraClient', () => {
  const validConfig = {
    host: 'https://test.atlassian.net',
    email: 'test@example.com',
    apiToken: 'test-token',
    projectKey: 'TEST',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create client with valid config', () => {
      const client = new JiraClient(validConfig);
      expect(client).toBeInstanceOf(JiraClient);
      expect(client.host).toBe(validConfig.host);
      expect(client.projectKey).toBe(validConfig.projectKey);
    });

    it('should throw validation error for invalid host', () => {
      expect(() => {
        new JiraClient({
          ...validConfig,
          host: 'not-a-url',
        });
      }).toThrow(JiraValidationError);
    });

    it('should throw validation error for invalid email', () => {
      expect(() => {
        new JiraClient({
          ...validConfig,
          email: 'not-an-email',
        });
      }).toThrow(JiraValidationError);
    });

    it('should throw validation error for empty API token', () => {
      expect(() => {
        new JiraClient({
          ...validConfig,
          apiToken: '',
        });
      }).toThrow(JiraValidationError);
    });

    it('should throw validation error for invalid project key', () => {
      expect(() => {
        new JiraClient({
          ...validConfig,
          projectKey: 'lowercase',
        });
      }).toThrow(JiraValidationError);
    });

    it('should accept config without optional project key', () => {
      const configWithoutProject = {
        host: 'https://test.atlassian.net',
        email: 'test@example.com',
        apiToken: 'test-token',
      };
      const client = new JiraClient(configWithoutProject);
      expect(client.projectKey).toBeUndefined();
    });
  });

  describe('verifyAuth', () => {
    it('should return user info on successful auth', async () => {
      const client = new JiraClient(validConfig);
      const user = await client.verifyAuth();

      expect(user).toEqual({
        accountId: 'test-account-id',
        displayName: 'Test User',
        email: 'test@example.com',
      });
    });

    it('should throw JiraAuthError on auth failure', async () => {
      const { Version3Client } = await import('jira.js');
      vi.mocked(Version3Client).mockImplementationOnce(() => ({
        myself: {
          getCurrentUser: vi.fn().mockRejectedValue(new Error('Unauthorized')),
        },
        serverInfo: { getServerInfo: vi.fn() },
      }) as unknown as ReturnType<typeof Version3Client>);

      const client = new JiraClient(validConfig);
      await expect(client.verifyAuth()).rejects.toThrow(JiraAuthError);
    });
  });

  describe('checkConnection', () => {
    it('should return server info on successful connection', async () => {
      const client = new JiraClient(validConfig);
      const info = await client.checkConnection();

      expect(info).toEqual({
        version: '1001.0.0-SNAPSHOT',
        baseUrl: 'https://test.atlassian.net',
      });
    });

    it('should throw JiraConnectionError on connection failure', async () => {
      const { Version3Client } = await import('jira.js');
      vi.mocked(Version3Client).mockImplementationOnce(() => ({
        myself: { getCurrentUser: vi.fn() },
        serverInfo: {
          getServerInfo: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        },
      }) as unknown as ReturnType<typeof Version3Client>);

      const client = new JiraClient(validConfig);
      await expect(client.checkConnection()).rejects.toThrow(JiraConnectionError);
    });
  });

  describe('request', () => {
    it('should execute operation and return result', async () => {
      const client = new JiraClient(validConfig);
      const result = await client.request(async () => ({ data: 'test' }));
      expect(result).toEqual({ data: 'test' });
    });

    it('should wrap rate limit errors', async () => {
      const client = new JiraClient(validConfig);
      const rateLimitError = { status: 429, message: 'Too many requests' };

      await expect(
        client.request(async () => {
          throw rateLimitError;
        }, 'test operation')
      ).rejects.toMatchObject({
        name: 'JiraRateLimitError',
        code: 'RATE_LIMIT_ERROR',
      });
    });
  });

  describe('paginate', () => {
    it('should yield all items from paginated results', async () => {
      const client = new JiraClient(validConfig);
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          values: [{ id: 1 }, { id: 2 }],
          total: 3,
          startAt: 0,
          maxResults: 2,
        })
        .mockResolvedValueOnce({
          values: [{ id: 3 }],
          total: 3,
          startAt: 2,
          maxResults: 2,
        });

      const items: { id: number }[] = [];
      for await (const item of client.paginate(mockFetch, { pageSize: 2 })) {
        items.push(item);
      }

      expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should stop at max pages limit', async () => {
      const client = new JiraClient(validConfig);
      const mockFetch = vi.fn().mockResolvedValue({
        values: [{ id: 1 }],
        total: 100,
        startAt: 0,
        maxResults: 1,
      });

      const items: { id: number }[] = [];
      for await (const item of client.paginate(mockFetch, { pageSize: 1, maxPages: 3 })) {
        items.push(item);
      }

      expect(items).toHaveLength(3);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });
});

describe('createClient', () => {
  it('should create a JiraClient instance', () => {
    const client = createClient({
      host: 'https://test.atlassian.net',
      email: 'test@example.com',
      apiToken: 'test-token',
    });
    expect(client).toBeInstanceOf(JiraClient);
  });
});

describe('createClientAsync', () => {
  it('should create and verify a JiraClient instance', async () => {
    const client = await createClientAsync({
      host: 'https://test.atlassian.net',
      email: 'test@example.com',
      apiToken: 'test-token',
    });
    expect(client).toBeInstanceOf(JiraClient);
  });
});
