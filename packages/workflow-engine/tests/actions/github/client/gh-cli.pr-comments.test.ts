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

  it('returns one element per comment, preserving internal newlines (#1047 Finding 1)', async () => {
    // Real gh output shape: JSON with a `comments` array, each element has
    // a `body` field. Internal newlines in a body must NOT split into
    // separate array elements.
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        comments: [
          { body: 'first body' },
          { body: 'second body' },
          {
            body:
              '<!-- generacy-cockpit:body-findings-unaddressed -->\n\n### Unaddressed findings\n\n- `bot` review #700 finding 1',
          },
        ],
      }),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const bodies = await client.listPrCommentBodies('o', 'r', 42);

    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toBe('first body');
    expect(bodies[1]).toBe('second body');
    // Third body is multi-line — must remain one array element with its
    // internal newlines intact so the ack-parser can find both the marker
    // line AND the enumeration row in the same string.
    expect(bodies[2]).toContain('<!-- generacy-cockpit:body-findings-unaddressed -->');
    expect(bodies[2]).toContain('- `bot` review #700 finding 1');
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      'gh',
      [
        'pr', 'view', '42',
        '--repo', 'o/r',
        '--json', 'comments',
      ],
      expect.objectContaining({ cwd: '/tmp' }),
    );
  });

  it('returns [] when stdout is empty or comments array absent', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const bodies = await client.listPrCommentBodies('o', 'r', 42);
    expect(bodies).toEqual([]);
  });

  it('drops entries with missing or non-string bodies', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({
        comments: [
          { body: 'kept' },
          { body: '' },
          {},
          { body: null },
        ],
      }),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const bodies = await client.listPrCommentBodies('o', 'r', 42);
    expect(bodies).toEqual(['kept']);
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
