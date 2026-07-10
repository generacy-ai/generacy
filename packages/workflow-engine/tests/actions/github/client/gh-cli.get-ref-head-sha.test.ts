import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try { return JSON.parse(input); } catch { return null; }
  }),
}));

import { executeCommand } from '../../../../src/actions/cli-utils.js';
import { GhCliGitHubClient, GhAuthError } from '../../../../src/actions/github/client/gh-cli.js';

const mockExecuteCommand = vi.mocked(executeCommand);

describe('GhCliGitHubClient.getRefHeadSha (#892)', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  it('returns a valid 40-hex SHA when gh api succeeds', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: 'a'.repeat(40) + '\n',
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const sha = await client.getRefHeadSha('acme', 'widgets', 'develop');

    expect(sha).toBe('a'.repeat(40));
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/acme/widgets/commits/develop', '--jq', '.sha'],
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('throws when stdout is not a 40-char hex SHA', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: 'not-a-sha\n',
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    await expect(
      client.getRefHeadSha('acme', 'widgets', 'develop'),
    ).rejects.toThrow(/Invalid SHA/);
  });

  it('throws when stdout is 40 chars but contains non-hex characters', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: 'g'.repeat(40) + '\n',
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    await expect(
      client.getRefHeadSha('acme', 'widgets', 'develop'),
    ).rejects.toThrow(/Invalid SHA/);
  });

  it('throws GhAuthError on HTTP 401 (via executeGh)', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 401: Bad credentials',
    });

    const client = new GhCliGitHubClient('/tmp');
    await expect(
      client.getRefHeadSha('acme', 'widgets', 'develop'),
    ).rejects.toBeInstanceOf(GhAuthError);
  });

  it('throws generic Error on non-auth failure with non-zero exit', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 404: not found',
    });

    const client = new GhCliGitHubClient('/tmp');
    await expect(
      client.getRefHeadSha('acme', 'widgets', 'nonexistent'),
    ).rejects.toThrow(/getRefHeadSha/);
  });
});
