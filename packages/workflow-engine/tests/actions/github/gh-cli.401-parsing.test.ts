import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try { return JSON.parse(input); } catch { return null; }
  }),
}));

import { executeCommand } from '../../../src/actions/cli-utils.js';
import { GhCliGitHubClient, GhAuthError, parseGhStatusCode } from '../../../src/actions/github/client/gh-cli.js';

const mockExecuteCommand = vi.mocked(executeCommand);

describe('parseGhStatusCode', () => {
  it('matches the GraphQL "HTTP 401: Bad credentials" form', () => {
    expect(
      parseGhStatusCode('HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login'),
    ).toBe(401);
  });

  it('matches the REST "gh: ... (HTTP 401)" form', () => {
    expect(parseGhStatusCode('gh: Bad credentials (HTTP 401)')).toBe(401);
  });

  it('matches when the HTTP line is not on the first line', () => {
    expect(
      parseGhStatusCode('some warning line\nHTTP 401: Bad credentials\nanother line'),
    ).toBe(401);
  });

  it('returns undefined for empty stderr', () => {
    expect(parseGhStatusCode('')).toBeUndefined();
  });

  it('returns the captured non-401 status code', () => {
    expect(parseGhStatusCode('HTTP 500: server error')).toBe(500);
    expect(parseGhStatusCode('gh: rate limited (HTTP 403)')).toBe(403);
  });

  it('returns undefined when no HTTP status appears', () => {
    expect(parseGhStatusCode('some other error message')).toBeUndefined();
  });
});

describe('GhCliGitHubClient executeGh — 401 classification', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  it('throws GhAuthError when gh stderr indicates HTTP 401 (GraphQL form)', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)',
    });

    const client = new GhCliGitHubClient('/tmp');
    await expect(client.getRepoInfo()).rejects.toBeInstanceOf(GhAuthError);
  });

  it('throws GhAuthError when gh stderr indicates HTTP 401 (REST form)', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'gh: Bad credentials (HTTP 401)',
    });

    const client = new GhCliGitHubClient('/tmp');
    await expect(
      client.listIssuesWithLabel('o', 'r', 'process:foo'),
    ).rejects.toBeInstanceOf(GhAuthError);
  });

  it('throws a generic Error (not GhAuthError) on non-401 failures', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 500: internal server error',
    });

    const client = new GhCliGitHubClient('/tmp');
    await expect(client.getRepoInfo()).rejects.toThrow(/Failed to get repo info/);
    await expect(client.getRepoInfo()).rejects.not.toBeInstanceOf(GhAuthError);
  });

  it('does not throw when exitCode is 0 even if stderr contains "HTTP 401"', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r', defaultBranchRef: { name: 'main' } }),
      stderr: 'HTTP 401: noise',
    });

    const client = new GhCliGitHubClient('/tmp');
    await expect(client.getRepoInfo()).resolves.toEqual({
      owner: 'o',
      repo: 'r',
      default_branch: 'main',
    });
  });

  it('preserves statusCode and stderr on GhAuthError', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 401: Bad credentials',
    });

    const client = new GhCliGitHubClient('/tmp');
    try {
      await client.getRepoInfo();
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GhAuthError);
      expect((err as GhAuthError).statusCode).toBe(401);
      expect((err as GhAuthError).stderr).toContain('HTTP 401');
    }
  });
});
