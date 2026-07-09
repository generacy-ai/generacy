import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try { return JSON.parse(input); } catch { return null; }
  }),
}));

import { executeCommand } from '../../../../src/actions/cli-utils.js';
import { GhCliGitHubClient } from '../../../../src/actions/github/client/gh-cli.js';

const mockExecuteCommand = vi.mocked(executeCommand);

describe('GhCliGitHubClient.listPrCommentBodies (#869 / FR-004)', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  it('splits stdout on newlines and drops empty lines', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: 'first body\nsecond body\n<!-- generacy:pr-feedback-untrusted-notice -->\n',
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const bodies = await client.listPrCommentBodies('o', 'r', 42);

    expect(bodies).toEqual([
      'first body',
      'second body',
      '<!-- generacy:pr-feedback-untrusted-notice -->',
    ]);
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'gh',
      [
        'pr', 'view', '42',
        '--repo', 'o/r',
        '--json', 'comments',
        '--jq', '.comments[].body',
      ],
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('returns [] when stdout is empty', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const bodies = await client.listPrCommentBodies('o', 'r', 42);
    expect(bodies).toEqual([]);
  });

  it('throws on non-zero exit', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'gh: something went wrong',
    });

    const client = new GhCliGitHubClient('/tmp');
    await expect(client.listPrCommentBodies('o', 'r', 42))
      .rejects.toThrow(/Failed to list PR comments/);
  });
});

describe('GhCliGitHubClient.postPrComment (#869 / FR-004)', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  it('invokes `gh pr comment` with the given body', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    await client.postPrComment('o', 'r', 42, 'notice body');

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'gh',
      [
        'pr', 'comment', '42',
        '--repo', 'o/r',
        '--body', 'notice body',
      ],
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('throws on non-zero exit', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'gh: permission denied',
    });

    const client = new GhCliGitHubClient('/tmp');
    await expect(client.postPrComment('o', 'r', 42, 'body'))
      .rejects.toThrow(/Failed to post PR comment/);
  });
});
