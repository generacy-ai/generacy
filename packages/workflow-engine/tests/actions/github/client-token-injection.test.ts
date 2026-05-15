/**
 * Tests for GhCliGitHubClient token injection via tokenProvider.
 *
 * Verifies that the tokenProvider constructor parameter correctly controls
 * the GH_TOKEN env var passed to executeCommand for all gh CLI calls.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the cli-utils module before importing the class under test
vi.mock('../../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try {
      return JSON.parse(input);
    } catch {
      return null;
    }
  }),
}));

import { GhCliGitHubClient } from '../../../src/actions/github/client/gh-cli.js';
import { executeCommand } from '../../../src/actions/cli-utils.js';

const mockExecuteCommand = vi.mocked(executeCommand);

/** Standard repo info JSON for mock responses */
const REPO_INFO_JSON = JSON.stringify({
  owner: { login: 'test-owner' },
  name: 'test-repo',
  defaultBranchRef: { name: 'main' },
});

/** Standard open PR list JSON for mock responses */
const PR_LIST_JSON = JSON.stringify([
  {
    number: 42,
    title: 'Test PR',
    body: 'PR body',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'feature-branch',
    baseRefName: 'main',
    labels: [],
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
]);

function successResult(stdout: string) {
  return { exitCode: 0, stdout, stderr: '' };
}

describe('GhCliGitHubClient token injection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('when tokenProvider returns a token', () => {
    it('passes GH_TOKEN in env to executeCommand', async () => {
      const tokenProvider = vi.fn().mockResolvedValue('my-secret-token');
      const client = new GhCliGitHubClient('/test/workdir', tokenProvider);

      mockExecuteCommand.mockResolvedValue(successResult(REPO_INFO_JSON));

      await client.getRepoInfo();

      expect(tokenProvider).toHaveBeenCalledOnce();
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        'gh',
        expect.any(Array),
        expect.objectContaining({
          cwd: '/test/workdir',
          env: { GH_TOKEN: 'my-secret-token' },
        }),
      );
    });

    it('passes GH_TOKEN for every gh CLI call', async () => {
      const tokenProvider = vi.fn().mockResolvedValue('per-call-token');
      const client = new GhCliGitHubClient('/test/workdir', tokenProvider);

      mockExecuteCommand.mockResolvedValue(successResult(PR_LIST_JSON));

      await client.listOpenPullRequests('owner', 'repo');

      expect(tokenProvider).toHaveBeenCalledOnce();
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['pr', 'list']),
        expect.objectContaining({
          env: { GH_TOKEN: 'per-call-token' },
        }),
      );
    });

    it('resolves the token on each method call', async () => {
      let callCount = 0;
      const tokenProvider = vi.fn().mockImplementation(async () => {
        callCount++;
        return `token-${callCount}`;
      });
      const client = new GhCliGitHubClient('/test/workdir', tokenProvider);

      mockExecuteCommand.mockResolvedValue(successResult(REPO_INFO_JSON));

      await client.getRepoInfo();
      await client.getRepoInfo();

      expect(tokenProvider).toHaveBeenCalledTimes(2);

      // First call should use token-1
      expect(mockExecuteCommand).toHaveBeenNthCalledWith(
        1,
        'gh',
        expect.any(Array),
        expect.objectContaining({
          env: { GH_TOKEN: 'token-1' },
        }),
      );

      // Second call should use token-2
      expect(mockExecuteCommand).toHaveBeenNthCalledWith(
        2,
        'gh',
        expect.any(Array),
        expect.objectContaining({
          env: { GH_TOKEN: 'token-2' },
        }),
      );
    });
  });

  describe('when tokenProvider is undefined (not set)', () => {
    it('passes env: undefined to executeCommand', async () => {
      const client = new GhCliGitHubClient('/test/workdir');

      mockExecuteCommand.mockResolvedValue(successResult(REPO_INFO_JSON));

      await client.getRepoInfo();

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        'gh',
        expect.any(Array),
        expect.objectContaining({
          cwd: '/test/workdir',
          env: undefined,
        }),
      );
    });

    it('passes env: undefined for listOpenPullRequests', async () => {
      const client = new GhCliGitHubClient('/test/workdir');

      mockExecuteCommand.mockResolvedValue(successResult(PR_LIST_JSON));

      await client.listOpenPullRequests('owner', 'repo');

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        'gh',
        expect.any(Array),
        expect.objectContaining({
          env: undefined,
        }),
      );
    });
  });

  describe('when tokenProvider returns undefined (resolution failed)', () => {
    it('passes env: undefined to executeCommand', async () => {
      const tokenProvider = vi.fn().mockResolvedValue(undefined);
      const client = new GhCliGitHubClient('/test/workdir', tokenProvider);

      mockExecuteCommand.mockResolvedValue(successResult(REPO_INFO_JSON));

      await client.getRepoInfo();

      expect(tokenProvider).toHaveBeenCalledOnce();
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        'gh',
        expect.any(Array),
        expect.objectContaining({
          cwd: '/test/workdir',
          env: undefined,
        }),
      );
    });

    it('passes env: undefined for PR listing when token resolution fails', async () => {
      const tokenProvider = vi.fn().mockResolvedValue(undefined);
      const client = new GhCliGitHubClient('/test/workdir', tokenProvider);

      mockExecuteCommand.mockResolvedValue(successResult(PR_LIST_JSON));

      await client.listOpenPullRequests('owner', 'repo');

      expect(tokenProvider).toHaveBeenCalledOnce();
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        'gh',
        expect.any(Array),
        expect.objectContaining({
          env: undefined,
        }),
      );
    });
  });

  describe('default workdir', () => {
    it('uses process.cwd() when workdir is not provided', async () => {
      const tokenProvider = vi.fn().mockResolvedValue('test-token');
      const client = new GhCliGitHubClient(undefined, tokenProvider);

      mockExecuteCommand.mockResolvedValue(successResult(REPO_INFO_JSON));

      await client.getRepoInfo();

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        'gh',
        expect.any(Array),
        expect.objectContaining({
          cwd: process.cwd(),
          env: { GH_TOKEN: 'test-token' },
        }),
      );
    });
  });
});
