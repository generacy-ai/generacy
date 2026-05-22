/**
 * Tests for unpushed commit detection in GhCliGitHubClient.getStatus()
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

function successResult(stdout: string) {
  return { exitCode: 0, stdout, stderr: '' };
}

function failResult(stderr: string) {
  return { exitCode: 128, stdout: '', stderr };
}

describe('GhCliGitHubClient.getStatus() unpushed detection', () => {
  let client: GhCliGitHubClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new GhCliGitHubClient('/test/workdir');
  });

  it('detects commits ahead of remote', async () => {
    // branch --show-current
    mockExecuteCommand.mockResolvedValueOnce(successResult('feature-branch\n'));
    // status --porcelain
    mockExecuteCommand.mockResolvedValueOnce(successResult(''));
    // rev-list --count origin/feature-branch..HEAD
    mockExecuteCommand.mockResolvedValueOnce(successResult('3\n'));

    const status = await client.getStatus();

    expect(status.hasUnpushed).toBe(true);
    expect(status.unpushedCount).toBe(3);
    expect(status.branch).toBe('feature-branch');
  });

  it('reports zero when branch is up to date with remote', async () => {
    mockExecuteCommand.mockResolvedValueOnce(successResult('main\n'));
    mockExecuteCommand.mockResolvedValueOnce(successResult(''));
    mockExecuteCommand.mockResolvedValueOnce(successResult('0\n'));

    const status = await client.getStatus();

    expect(status.hasUnpushed).toBe(false);
    expect(status.unpushedCount).toBe(0);
  });

  it('treats missing remote tracking branch as 0 unpushed', async () => {
    mockExecuteCommand.mockResolvedValueOnce(successResult('new-branch\n'));
    mockExecuteCommand.mockResolvedValueOnce(successResult(''));
    // rev-list fails because origin/new-branch doesn't exist
    mockExecuteCommand.mockResolvedValueOnce(failResult('fatal: bad revision'));

    const status = await client.getStatus();

    expect(status.hasUnpushed).toBe(false);
    expect(status.unpushedCount).toBe(0);
  });

  it('handles detached HEAD (empty branch)', async () => {
    mockExecuteCommand.mockResolvedValueOnce(successResult('\n'));
    mockExecuteCommand.mockResolvedValueOnce(successResult(''));
    // No rev-list call expected when branch is empty

    const status = await client.getStatus();

    expect(status.hasUnpushed).toBe(false);
    expect(status.unpushedCount).toBe(0);
    expect(status.branch).toBe('');
    // Should only have called branch and status, not rev-list
    expect(mockExecuteCommand).toHaveBeenCalledTimes(2);
  });

  it('includes both working tree status and unpushed info', async () => {
    mockExecuteCommand.mockResolvedValueOnce(successResult('feature\n'));
    mockExecuteCommand.mockResolvedValueOnce(successResult(' M src/file.ts\n?? new-file.ts\n'));
    mockExecuteCommand.mockResolvedValueOnce(successResult('2\n'));

    const status = await client.getStatus();

    expect(status.has_changes).toBe(true);
    expect(status.unstaged).toContain('src/file.ts');
    expect(status.untracked).toContain('new-file.ts');
    expect(status.hasUnpushed).toBe(true);
    expect(status.unpushedCount).toBe(2);
  });

  it('handles rev-list throwing an exception gracefully', async () => {
    mockExecuteCommand.mockResolvedValueOnce(successResult('feature\n'));
    mockExecuteCommand.mockResolvedValueOnce(successResult(''));
    mockExecuteCommand.mockRejectedValueOnce(new Error('command not found'));

    const status = await client.getStatus();

    expect(status.hasUnpushed).toBe(false);
    expect(status.unpushedCount).toBe(0);
  });
});
