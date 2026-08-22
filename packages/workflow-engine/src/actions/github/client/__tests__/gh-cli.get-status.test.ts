/**
 * Unit tests for GhCliGitHubClient.getStatus porcelain invocation + parsing.
 *
 * `git status --porcelain` without `--untracked-files=all` collapses a wholly
 * untracked directory into a single `?? dir/` entry, hiding the files inside
 * from path-based consumers. The orchestrator's engine-sidecar staging filter
 * (#1162) matches on file paths under `.generacy/`, so a collapsed `?? .generacy/`
 * entry was staged wholesale — committing every sidecar. `getStatus` must ask
 * git for every untracked file individually.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try { return JSON.parse(input); } catch { return null; }
  }),
}));

import { executeCommand } from '../../../cli-utils.js';
import { GhCliGitHubClient } from '../gh-cli.js';

const mockExecuteCommand = vi.mocked(executeCommand);

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: '' };
}

describe('GhCliGitHubClient.getStatus', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  it('runs `git status --porcelain --untracked-files=all` in the workdir', async () => {
    mockExecuteCommand
      .mockResolvedValueOnce(ok('feature\n'))   // branch --show-current
      .mockResolvedValueOnce(ok(''))            // status
      .mockResolvedValueOnce(ok('0\n'));        // rev-list --count
    const client = new GhCliGitHubClient('/tmp/checkout');

    await client.getStatus();

    expect(mockExecuteCommand.mock.calls[1]).toEqual([
      'git',
      ['status', '--porcelain', '--untracked-files=all'],
      { cwd: '/tmp/checkout' },
    ]);
  });

  it('reports each untracked file under an untracked directory individually', async () => {
    // What git emits WITH --untracked-files=all for a wholly-untracked .generacy/.
    mockExecuteCommand
      .mockResolvedValueOnce(ok('feature\n'))
      .mockResolvedValueOnce(ok([
        ' M src/modified.ts',
        'A  src/added.ts',
        'MM src/both.ts',
        '?? .generacy/review-findings-o_r_42.json',
        '?? .generacy/pause-context-o_r_42.json',
        '?? src/new.ts',
      ].join('\n') + '\n'))
      .mockResolvedValueOnce(ok('0\n'));
    const client = new GhCliGitHubClient('/tmp/checkout');

    const status = await client.getStatus();

    expect(status.untracked).toEqual([
      '.generacy/review-findings-o_r_42.json',
      '.generacy/pause-context-o_r_42.json',
      'src/new.ts',
    ]);
    expect(status.untracked).not.toContain('.generacy/');
    expect(status.unstaged).toEqual(['src/modified.ts', 'src/both.ts']);
    expect(status.staged).toEqual(['src/added.ts', 'src/both.ts']);
    expect(status.has_changes).toBe(true);
    expect(status.branch).toBe('feature');
  });
});
