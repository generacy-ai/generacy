import { describe, it, expect, vi } from 'vitest';
import { GitHubClient, createClient } from '../src/client.js';
import { ConfigurationError, RateLimitError } from '../src/utils/errors.js';

describe('GitHubClient', () => {
  const validConfig = {
    owner: 'test-owner',
    repo: 'test-repo',
    token: 'ghp_test_token',
  };

  describe('constructor', () => {
    it('should create a client with valid configuration', () => {
      const client = new GitHubClient(validConfig);
      expect(client.getOwner()).toBe('test-owner');
      expect(client.getRepo()).toBe('test-repo');
    });

    it('should throw ConfigurationError if owner is missing', () => {
      expect(() => {
        new GitHubClient({ ...validConfig, owner: '' });
      }).toThrow(ConfigurationError);
    });

    it('should throw ConfigurationError if repo is missing', () => {
      expect(() => {
        new GitHubClient({ ...validConfig, repo: '' });
      }).toThrow(ConfigurationError);
    });

    it('should throw ConfigurationError if token is missing', () => {
      expect(() => {
        new GitHubClient({ ...validConfig, token: '' });
      }).toThrow(ConfigurationError);
    });
  });

  describe('createClient', () => {
    it('should create a GitHubClient instance', () => {
      const client = createClient(validConfig);
      expect(client).toBeInstanceOf(GitHubClient);
    });
  });

  describe('getOctokit', () => {
    it('should return the Octokit instance', () => {
      const client = new GitHubClient(validConfig);
      const octokit = client.getOctokit();
      expect(octokit).toBeDefined();
      expect(octokit.rest).toBeDefined();
    });
  });

  describe('request', () => {
    it('should return data from successful request', async () => {
      const client = new GitHubClient(validConfig);
      const mockData = { id: 1, name: 'test' };

      const result = await client.request(async () => ({
        data: mockData,
      }));

      expect(result).toEqual(mockData);
    });

    it('should throw RateLimitError on 403 status', async () => {
      const client = new GitHubClient(validConfig);
      const rateLimitError = {
        status: 403,
        response: {
          headers: {
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      };

      await expect(
        client.request(async () => {
          throw rateLimitError;
        })
      ).rejects.toThrow(RateLimitError);
    });

    it('should throw RateLimitError on 429 status', async () => {
      const client = new GitHubClient(validConfig);
      const rateLimitError = {
        status: 429,
        response: {
          headers: {
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      };

      await expect(
        client.request(async () => {
          throw rateLimitError;
        })
      ).rejects.toThrow(RateLimitError);
    });

    it('should propagate non-rate-limit errors', async () => {
      const client = new GitHubClient(validConfig);
      const testError = new Error('Test error');

      await expect(
        client.request(async () => {
          throw testError;
        })
      ).rejects.toThrow('Test error');
    });
  });

  describe('requestRaw', () => {
    it('should return raw data from successful request', async () => {
      const client = new GitHubClient(validConfig);
      const mockData = 'raw log data';

      const result = await client.requestRaw(async () => mockData);

      expect(result).toBe(mockData);
    });

    it('should throw RateLimitError on rate limit', async () => {
      const client = new GitHubClient(validConfig);
      const rateLimitError = {
        status: 403,
        response: {
          headers: {
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
          },
        },
      };

      await expect(
        client.requestRaw(async () => {
          throw rateLimitError;
        })
      ).rejects.toThrow(RateLimitError);
    });
  });
});

describe('RateLimitError', () => {
  it('should calculate time until reset', () => {
    const resetAt = new Date(Date.now() + 60000); // 60 seconds from now
    const error = new RateLimitError(resetAt);

    const timeUntilReset = error.getTimeUntilReset();
    expect(timeUntilReset).toBeGreaterThan(50000);
    expect(timeUntilReset).toBeLessThanOrEqual(60000);
  });

  it('should return 0 if reset time has passed', () => {
    const resetAt = new Date(Date.now() - 1000); // 1 second ago
    const error = new RateLimitError(resetAt);

    expect(error.getTimeUntilReset()).toBe(0);
  });
});
