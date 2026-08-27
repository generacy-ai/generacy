import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try { return JSON.parse(input); } catch { return null; }
  }),
}));

import { executeCommand } from '../../../src/actions/cli-utils.js';
import { GhCliGitHubClient } from '../../../src/actions/github/client/gh-cli.js';

const mockExecuteCommand = vi.mocked(executeCommand);

describe('GhCliGitHubClient.getIssueRefState', () => {
  let client: GhCliGitHubClient;

  beforeEach(() => {
    mockExecuteCommand.mockReset();
    client = new GhCliGitHubClient('/fake/workdir');
  });

  it('returns state for an open issue', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ state: 'open', state_reason: null, pull_request: false }),
      stderr: '',
    });

    const result = await client.getIssueRefState('org', 'repo', 42);
    expect(result).toEqual({
      state: 'open',
      stateReason: null,
      isPullRequest: false,
      merged: null,
    });
  });

  it('returns state for a closed issue (completed)', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ state: 'closed', state_reason: 'completed', pull_request: false }),
      stderr: '',
    });

    const result = await client.getIssueRefState('org', 'repo', 42);
    expect(result).toEqual({
      state: 'closed',
      stateReason: 'completed',
      isPullRequest: false,
      merged: null,
    });
  });

  it('returns state for a closed issue (not_planned)', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ state: 'closed', state_reason: 'not_planned', pull_request: false }),
      stderr: '',
    });

    const result = await client.getIssueRefState('org', 'repo', 42);
    expect(result).toEqual({
      state: 'closed',
      stateReason: 'not_planned',
      isPullRequest: false,
      merged: null,
    });
  });

  it('returns state for an open PR', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ state: 'open', state_reason: null, pull_request: true }),
      stderr: '',
    });
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'false',
      stderr: '',
    });

    const result = await client.getIssueRefState('org', 'repo', 42);
    expect(result).toEqual({
      state: 'open',
      stateReason: null,
      isPullRequest: true,
      merged: false,
    });
    expect(mockExecuteCommand).toHaveBeenCalledTimes(2);
  });

  it('returns state for a merged PR', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ state: 'closed', state_reason: null, pull_request: true }),
      stderr: '',
    });
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'true',
      stderr: '',
    });

    const result = await client.getIssueRefState('org', 'repo', 42);
    expect(result).toEqual({
      state: 'closed',
      stateReason: null,
      isPullRequest: true,
      merged: true,
    });
  });

  it('returns state for a closed unmerged PR', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ state: 'closed', state_reason: null, pull_request: true }),
      stderr: '',
    });
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'false',
      stderr: '',
    });

    const result = await client.getIssueRefState('org', 'repo', 42);
    expect(result).toEqual({
      state: 'closed',
      stateReason: null,
      isPullRequest: true,
      merged: false,
    });
  });

  it('throws on non-zero exit from issue API', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Not Found',
    });

    await expect(client.getIssueRefState('org', 'repo', 42)).rejects.toThrow('Failed to get issue ref state');
  });

  it('throws on non-zero exit from pulls API for PRs', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ state: 'open', state_reason: null, pull_request: true }),
      stderr: '',
    });
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Not Found',
    });

    await expect(client.getIssueRefState('org', 'repo', 42)).rejects.toThrow('Failed to get PR merged state');
  });

  it('throws on unparseable issue JSON', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'not json',
      stderr: '',
    });

    await expect(client.getIssueRefState('org', 'repo', 42)).rejects.toThrow('Failed to parse issue ref state');
  });
});