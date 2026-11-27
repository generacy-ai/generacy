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

  it('runs `git status --porcelain -z --untracked-files=all` in the workdir', async () => {
    mockExecuteCommand
      .mockResolvedValueOnce(ok('feature\n'))   // branch --show-current
      .mockResolvedValueOnce(ok(''))            // status
      .mockResolvedValueOnce(ok('0\n'));        // rev-list --count
    const client = new GhCliGitHubClient('/tmp/checkout');

    await client.getStatus();

    expect(mockExecuteCommand.mock.calls[1]).toEqual([
      'git',
      ['status', '--porcelain', '-z', '--untracked-files=all'],
      { cwd: '/tmp/checkout' },
    ]);
  });

  it('reports each untracked file under an untracked directory individually', async () => {
    // What git emits WITH -z --untracked-files=all for a wholly-untracked
    // .generacy/: NUL-terminated entries, no `\n`.
    mockExecuteCommand
      .mockResolvedValueOnce(ok('feature\n'))
      .mockResolvedValueOnce(ok([
        ' M src/modified.ts',
        'A  src/added.ts',
        'MM src/both.ts',
        '?? .generacy/review-findings-o_r_42.json',
        '?? .generacy/pause-context-o_r_42.json',
        '?? src/new.ts',
      ].join('\0') + '\0'))
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

  // #1239: with -z, a rename/copy entry emits the destination path in the
  // header token and the source path as the immediately-following NUL token,
  // instead of the `old -> new` arrow the line-split format produced. The parser
  // must consume both and surface real paths — never the arrow artifact.
  it('parses a staged rename into source + dest, never the arrow artifact', async () => {
    mockExecuteCommand
      .mockResolvedValueOnce(ok('feature\n'))
      // `R  new.ts\0old.ts\0` — staged rename (index column R, dest then source).
      .mockResolvedValueOnce(ok('R  src/new.ts\0src/old.ts\0'))
      .mockResolvedValueOnce(ok('0\n'));
    const client = new GhCliGitHubClient('/tmp/checkout');

    const status = await client.getStatus();

    expect(status.staged).toEqual(['src/new.ts', 'src/old.ts']);
    expect(status.unstaged).toEqual([]);
    expect(status.untracked).toEqual([]);
    expect(status.has_changes).toBe(true);
    for (const p of [...status.staged, ...status.unstaged, ...status.untracked]) {
      expect(p).not.toContain('->');
    }
  });

  it('parses an `RM` entry: dest+source staged, dest unstaged, one has_changes entry', async () => {
    mockExecuteCommand
      .mockResolvedValueOnce(ok('feature\n'))
      // `RM new.ts\0old.ts\0` — renamed in index (R) with further working-tree
      // modification (M). Source rides the next token; dest is both staged and
      // unstaged. Plus a plain working-tree modification.
      .mockResolvedValueOnce(ok('RM src/new.ts\0src/old.ts\0 M src/other.ts\0'))
      .mockResolvedValueOnce(ok('0\n'));
    const client = new GhCliGitHubClient('/tmp/checkout');

    const status = await client.getStatus();

    expect(status.staged).toEqual(['src/new.ts', 'src/old.ts']);
    expect(status.unstaged).toEqual(['src/new.ts', 'src/other.ts']);
    expect(status.untracked).toEqual([]);
    // Two porcelain entries (RM + ` M`), not the four NUL tokens.
    expect(status.has_changes).toBe(true);
    for (const p of [...status.staged, ...status.unstaged, ...status.untracked]) {
      expect(p).not.toContain('->');
    }
  });

  it('preserves paths containing spaces verbatim (no v1 quoting under -z)', async () => {
    mockExecuteCommand
      .mockResolvedValueOnce(ok('feature\n'))
      .mockResolvedValueOnce(ok([
        'R  dst dir/new name.ts',
        'src dir/old name.ts',
        '?? untracked file.ts',
      ].join('\0') + '\0'))
      .mockResolvedValueOnce(ok('0\n'));
    const client = new GhCliGitHubClient('/tmp/checkout');

    const status = await client.getStatus();

    expect(status.staged).toEqual(['dst dir/new name.ts', 'src dir/old name.ts']);
    expect(status.untracked).toEqual(['untracked file.ts']);
  });
});
