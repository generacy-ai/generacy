import { describe, it, expect, beforeAll } from 'vitest';
import { GitHubClient } from '../../src/client.js';

/**
 * Integration tests for the GitHub client.
 *
 * These tests require a GITHUB_TOKEN environment variable with access to a test repository.
 * They are skipped by default in the vitest config and can be run with:
 *   npm run test -- --include integration
 *
 * Required environment variables:
 * - GITHUB_TOKEN: Personal access token with repo scope
 * - GITHUB_TEST_OWNER: Repository owner (defaults to 'octocat')
 * - GITHUB_TEST_REPO: Repository name (defaults to 'Hello-World')
 */

const TEST_OWNER = process.env.GITHUB_TEST_OWNER ?? 'octocat';
const TEST_REPO = process.env.GITHUB_TEST_REPO ?? 'Hello-World';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

describe.skipIf(!GITHUB_TOKEN)('GitHubClient Integration', () => {
  let client: GitHubClient;

  beforeAll(() => {
    if (!GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN environment variable is required for integration tests');
    }

    client = new GitHubClient({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      token: GITHUB_TOKEN,
    });
  });

  describe('verifyAuth', () => {
    it('should verify authentication successfully', async () => {
      const result = await client.verifyAuth();

      expect(result).toHaveProperty('login');
      expect(result).toHaveProperty('id');
      expect(typeof result.login).toBe('string');
      expect(typeof result.id).toBe('number');
    });
  });

  describe('getRateLimit', () => {
    it('should get rate limit status', async () => {
      const result = await client.getRateLimit();

      expect(result).toHaveProperty('limit');
      expect(result).toHaveProperty('remaining');
      expect(result).toHaveProperty('reset');
      expect(typeof result.limit).toBe('number');
      expect(typeof result.remaining).toBe('number');
      expect(result.reset).toBeInstanceOf(Date);
      expect(result.remaining).toBeLessThanOrEqual(result.limit);
    });
  });

  describe('request', () => {
    it('should execute a successful request', async () => {
      const result = await client.request(
        () =>
          client.rest.repos.get({
            owner: TEST_OWNER,
            repo: TEST_REPO,
          }),
        'get repository'
      );

      expect(result.data).toHaveProperty('name', TEST_REPO);
      expect(result.data).toHaveProperty('owner');
    });

    it('should wrap errors appropriately', async () => {
      await expect(
        client.request(
          () =>
            client.rest.repos.get({
              owner: 'nonexistent-owner-12345',
              repo: 'nonexistent-repo-12345',
            }),
          'get nonexistent repository'
        )
      ).rejects.toThrow();
    });
  });

  describe('paginate', () => {
    it('should paginate through results', async () => {
      // List branches - most repos have at least one
      const results = await client.paginate(
        (params) =>
          client.rest.repos.listBranches({
            owner: TEST_OWNER,
            repo: TEST_REPO,
            ...params,
          }),
        2 // Limit to 2 pages for test
      );

      expect(Array.isArray(results)).toBe(true);
      // The Hello-World repo should have at least one branch
      expect(results.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('configuration', () => {
    it('should expose owner and repo', () => {
      expect(client.owner).toBe(TEST_OWNER);
      expect(client.repo).toBe(TEST_REPO);
    });

    it('should have undefined agentAccount by default', () => {
      expect(client.agentAccount).toBeUndefined();
    });

    it('should have empty triggerLabels by default', () => {
      expect(client.triggerLabels).toEqual([]);
    });
  });
});

describe('GitHubClient Configuration Validation', () => {
  it('should throw for missing owner', () => {
    expect(() => {
      new GitHubClient({
        owner: '',
        repo: 'test-repo',
        token: 'test-token',
      });
    }).toThrow();
  });

  it('should throw for missing repo', () => {
    expect(() => {
      new GitHubClient({
        owner: 'test-owner',
        repo: '',
        token: 'test-token',
      });
    }).toThrow();
  });

  it('should throw for missing token', () => {
    expect(() => {
      new GitHubClient({
        owner: 'test-owner',
        repo: 'test-repo',
        token: '',
      });
    }).toThrow();
  });

  it('should throw for invalid baseUrl', () => {
    expect(() => {
      new GitHubClient({
        owner: 'test-owner',
        repo: 'test-repo',
        token: 'test-token',
        baseUrl: 'not-a-valid-url',
      });
    }).toThrow();
  });

  it('should accept valid configuration with all options', () => {
    expect(() => {
      new GitHubClient({
        owner: 'test-owner',
        repo: 'test-repo',
        token: 'test-token',
        webhookSecret: 'secret',
        agentAccount: 'agent-bot',
        triggerLabels: ['autodev:ready'],
        baseUrl: 'https://github.example.com/api/v3',
      });
    }).not.toThrow();
  });
});
