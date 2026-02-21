import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PrManager } from './pr-manager.js';
import type { GitHubClient } from '@generacy-ai/workflow-engine';
import type { Logger } from './types.js';

/**
 * Create a mock logger that implements the Logger interface
 */
function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
}

/**
 * Create a mock GitHubClient with all required methods
 */
function createMockGitHubClient(
  overrides: Partial<GitHubClient> = {},
): GitHubClient {
  return {
    // Methods used by PrManager
    getStatus: vi.fn().mockResolvedValue({ has_changes: false }),
    stageAll: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ sha: 'abc123', files_committed: [] }),
    push: vi.fn().mockResolvedValue({ ref: 'refs/heads/test', remote: 'origin' }),
    getCurrentBranch: vi.fn().mockResolvedValue('test-branch'),
    findPRForBranch: vi.fn().mockResolvedValue(null),
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
    createPullRequest: vi.fn().mockResolvedValue({ number: 42, url: 'https://github.com/test/repo/pull/42' }),
    markPRReady: vi.fn().mockResolvedValue(undefined),

    // Other GitHubClient methods (not used by PrManager but required by interface)
    clone: vi.fn().mockResolvedValue(undefined),
    checkout: vi.fn().mockResolvedValue(undefined),
    listLabels: vi.fn().mockResolvedValue([]),
    createLabel: vi.fn().mockResolvedValue(undefined),
    addLabelsToIssue: vi.fn().mockResolvedValue(undefined),
    removeLabelsFromIssue: vi.fn().mockResolvedValue(undefined),
    getIssueLabels: vi.fn().mockResolvedValue([]),
    createIssueComment: vi.fn().mockResolvedValue(undefined),
    updateIssueComment: vi.fn().mockResolvedValue(undefined),
    listIssueComments: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue({ number: 1, title: 'Test', state: 'open' }),

    ...overrides,
  } as unknown as GitHubClient;
}

describe('PrManager', () => {
  let logger: Logger;
  let github: GitHubClient;
  let prManager: PrManager;

  const owner = 'test-owner';
  const repo = 'test-repo';
  const issueNumber = 123;

  beforeEach(() => {
    logger = createMockLogger();
    github = createMockGitHubClient();
    prManager = new PrManager(github, owner, repo, issueNumber, logger);
  });

  describe('markReadyForReview()', () => {
    it('should do nothing if no PR number is available', async () => {
      await prManager.markReadyForReview();

      expect(github.markPRReady).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        'No PR number available — skipping markReadyForReview',
      );
    });

    it('should call markPRReady with correct parameters when PR exists', async () => {
      // First create a PR to set the PR number
      github.findPRForBranch = vi.fn().mockResolvedValue({
        number: 42,
        url: 'https://github.com/test-owner/test-repo/pull/42',
      });

      await prManager.commitPushAndEnsurePr('specify');

      // Now mark it as ready
      await prManager.markReadyForReview();

      expect(github.markPRReady).toHaveBeenCalledWith(owner, repo, 42);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          prNumber: 42,
          prUrl: expect.stringContaining('/pull/42'),
        }),
        'Marked PR as ready for review',
      );
    });

    it('should log info with correct PR details after marking ready', async () => {
      // Create a new PR
      github.createPullRequest = vi.fn().mockResolvedValue({
        number: 99,
        url: 'https://github.com/test-owner/test-repo/pull/99',
      });
      github.getStatus = vi.fn().mockResolvedValue({ has_changes: true });

      await prManager.commitPushAndEnsurePr('implement');

      // Mark it as ready
      await prManager.markReadyForReview();

      expect(logger.info).toHaveBeenCalledWith(
        {
          prNumber: 99,
          prUrl: 'https://github.com/test-owner/test-repo/pull/99',
        },
        'Marked PR as ready for review',
      );
    });

    it('should handle errors gracefully and log warning', async () => {
      // Set up a PR
      github.findPRForBranch = vi.fn().mockResolvedValue({
        number: 42,
        url: 'https://github.com/test-owner/test-repo/pull/42',
      });
      await prManager.commitPushAndEnsurePr('specify');

      // Make markPRReady fail
      const error = new Error('GitHub API error');
      github.markPRReady = vi.fn().mockRejectedValue(error);

      // Should not throw
      await expect(prManager.markReadyForReview()).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          prNumber: 42,
          error: 'Error: GitHub API error',
        }),
        'Failed to mark PR as ready for review (non-fatal)',
      );
    });

    it('should call markPRReady exactly once', async () => {
      // Set up a PR
      github.findPRForBranch = vi.fn().mockResolvedValue({
        number: 42,
        url: 'https://github.com/test-owner/test-repo/pull/42',
      });
      await prManager.commitPushAndEnsurePr('specify');

      await prManager.markReadyForReview();

      expect(github.markPRReady).toHaveBeenCalledTimes(1);
    });

    it('should be idempotent - calling multiple times is safe', async () => {
      // Set up a PR
      github.findPRForBranch = vi.fn().mockResolvedValue({
        number: 42,
        url: 'https://github.com/test-owner/test-repo/pull/42',
      });
      await prManager.commitPushAndEnsurePr('specify');

      // Call multiple times
      await prManager.markReadyForReview();
      await prManager.markReadyForReview();
      await prManager.markReadyForReview();

      // markPRReady should be called each time (GitHub API is idempotent)
      expect(github.markPRReady).toHaveBeenCalledTimes(3);
      expect(github.markPRReady).toHaveBeenCalledWith(owner, repo, 42);
    });

    it('should work after creating a new PR (not finding existing)', async () => {
      // No existing PR
      github.findPRForBranch = vi.fn().mockResolvedValue(null);
      github.createPullRequest = vi.fn().mockResolvedValue({
        number: 77,
        url: 'https://github.com/test-owner/test-repo/pull/77',
      });
      github.getStatus = vi.fn().mockResolvedValue({ has_changes: true });

      await prManager.commitPushAndEnsurePr('tasks');

      // Mark it as ready
      await prManager.markReadyForReview();

      expect(github.markPRReady).toHaveBeenCalledWith(owner, repo, 77);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ prNumber: 77 }),
        'Marked PR as ready for review',
      );
    });

    it('should handle network errors without throwing', async () => {
      // Set up a PR
      github.findPRForBranch = vi.fn().mockResolvedValue({
        number: 42,
        url: 'https://github.com/test-owner/test-repo/pull/42',
      });
      await prManager.commitPushAndEnsurePr('specify');

      // Simulate network error
      github.markPRReady = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(prManager.markReadyForReview()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalled();
    });

    it('should handle rate limit errors without throwing', async () => {
      // Set up a PR
      github.findPRForBranch = vi.fn().mockResolvedValue({
        number: 42,
        url: 'https://github.com/test-owner/test-repo/pull/42',
      });
      await prManager.commitPushAndEnsurePr('specify');

      // Simulate rate limit error
      const rateLimitError = new Error('API rate limit exceeded');
      github.markPRReady = vi.fn().mockRejectedValue(rateLimitError);

      await expect(prManager.markReadyForReview()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          prNumber: 42,
          error: 'Error: API rate limit exceeded',
        }),
        'Failed to mark PR as ready for review (non-fatal)',
      );
    });

    it('should preserve PR number across multiple operations', async () => {
      // Create initial PR
      github.findPRForBranch = vi.fn().mockResolvedValue({
        number: 55,
        url: 'https://github.com/test-owner/test-repo/pull/55',
      });

      // Call multiple times with different phases
      await prManager.commitPushAndEnsurePr('specify');
      await prManager.commitPushAndEnsurePr('plan');
      await prManager.commitPushAndEnsurePr('implement');

      // Mark ready should use the same PR number
      await prManager.markReadyForReview();

      expect(github.markPRReady).toHaveBeenCalledWith(owner, repo, 55);
    });

    it('should handle undefined error object gracefully', async () => {
      // Set up a PR
      github.findPRForBranch = vi.fn().mockResolvedValue({
        number: 42,
        url: 'https://github.com/test-owner/test-repo/pull/42',
      });
      await prManager.commitPushAndEnsurePr('specify');

      // Simulate rejection with undefined/null
      github.markPRReady = vi.fn().mockRejectedValue(undefined);

      await expect(prManager.markReadyForReview()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          prNumber: 42,
          error: 'undefined',
        }),
        'Failed to mark PR as ready for review (non-fatal)',
      );
    });

    it('should handle non-Error exceptions gracefully', async () => {
      // Set up a PR
      github.findPRForBranch = vi.fn().mockResolvedValue({
        number: 42,
        url: 'https://github.com/test-owner/test-repo/pull/42',
      });
      await prManager.commitPushAndEnsurePr('specify');

      // Simulate rejection with a plain string
      github.markPRReady = vi.fn().mockRejectedValue('Something went wrong');

      await expect(prManager.markReadyForReview()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          prNumber: 42,
          error: 'Something went wrong',
        }),
        'Failed to mark PR as ready for review (non-fatal)',
      );
    });

    it('should handle GitHub GraphQL errors without throwing', async () => {
      // Set up a PR
      github.findPRForBranch = vi.fn().mockResolvedValue({
        number: 42,
        url: 'https://github.com/test-owner/test-repo/pull/42',
      });
      await prManager.commitPushAndEnsurePr('specify');

      // Simulate GraphQL error structure
      const graphqlError = new Error('GraphQL Error');
      Object.assign(graphqlError, {
        errors: [{ message: 'PR is not in draft state' }],
      });
      github.markPRReady = vi.fn().mockRejectedValue(graphqlError);

      await expect(prManager.markReadyForReview()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          prNumber: 42,
          error: expect.stringContaining('GraphQL Error'),
        }),
        'Failed to mark PR as ready for review (non-fatal)',
      );
    });

    it('should not attempt to mark ready if commitPushAndEnsurePr fails to create PR', async () => {
      // Simulate PR creation failure
      github.findPRForBranch = vi.fn().mockResolvedValue(null);
      github.createPullRequest = vi.fn().mockRejectedValue(new Error('PR creation failed'));
      github.getStatus = vi.fn().mockResolvedValue({ has_changes: true });

      // This should fail to create a PR
      await prManager.commitPushAndEnsurePr('specify');

      // Mark ready should be a no-op
      await prManager.markReadyForReview();

      expect(github.markPRReady).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        'No PR number available — skipping markReadyForReview',
      );
    });

    it('should handle timeout errors without throwing', async () => {
      // Set up a PR
      github.findPRForBranch = vi.fn().mockResolvedValue({
        number: 42,
        url: 'https://github.com/test-owner/test-repo/pull/42',
      });
      await prManager.commitPushAndEnsurePr('specify');

      // Simulate timeout error
      const timeoutError = new Error('Request timeout');
      Object.assign(timeoutError, { code: 'ETIMEDOUT' });
      github.markPRReady = vi.fn().mockRejectedValue(timeoutError);

      await expect(prManager.markReadyForReview()).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          prNumber: 42,
          error: expect.stringContaining('Request timeout'),
        }),
        'Failed to mark PR as ready for review (non-fatal)',
      );
    });

    it('should work correctly when called immediately after PR creation', async () => {
      // Create a brand new PR
      github.findPRForBranch = vi.fn().mockResolvedValue(null);
      github.createPullRequest = vi.fn().mockResolvedValue({
        number: 123,
        url: 'https://github.com/test-owner/test-repo/pull/123',
      });
      github.getStatus = vi.fn().mockResolvedValue({ has_changes: true });

      await prManager.commitPushAndEnsurePr('specify');

      // Immediately mark as ready
      await prManager.markReadyForReview();

      expect(github.markPRReady).toHaveBeenCalledWith(owner, repo, 123);
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ prNumber: 123 }),
        'Marked PR as ready for review',
      );
    });

    it('should maintain PR URL consistency after marking ready', async () => {
      // Set up a PR
      const expectedUrl = 'https://github.com/test-owner/test-repo/pull/88';
      github.findPRForBranch = vi.fn().mockResolvedValue({
        number: 88,
        url: expectedUrl,
      });

      await prManager.commitPushAndEnsurePr('specify');
      const urlBeforeReady = prManager.getPrUrl();

      await prManager.markReadyForReview();
      const urlAfterReady = prManager.getPrUrl();

      // URL should remain the same
      expect(urlBeforeReady).toBe(expectedUrl);
      expect(urlAfterReady).toBe(expectedUrl);
      expect(urlBeforeReady).toBe(urlAfterReady);
    });
  });

  describe('getPrUrl()', () => {
    it('should return undefined when no PR has been created', () => {
      expect(prManager.getPrUrl()).toBeUndefined();
    });

    it('should return PR URL after a PR is created', async () => {
      github.findPRForBranch = vi.fn().mockResolvedValue({
        number: 42,
        url: 'https://github.com/test-owner/test-repo/pull/42',
      });

      await prManager.commitPushAndEnsurePr('specify');

      expect(prManager.getPrUrl()).toBe('https://github.com/test-owner/test-repo/pull/42');
    });
  });
});
