/**
 * Unit tests for GhCliGitHubClient.discardWorkingTreeChanges (#1158 PR #1173).
 *
 * The method backs the phase loop's "branch untouched" guarantee (FR-007 /
 * SC-005) when a clean-run remediate exits non-zero: it must hard-reset tracked
 * changes AND remove untracked files, forwarding caller-supplied excludes to
 * `git clean -e` so orchestrator sidecars under `.generacy/` survive.
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

describe('GhCliGitHubClient.discardWorkingTreeChanges', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
    mockExecuteCommand.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  });

  it('hard-resets to HEAD then cleans untracked files in this.workdir', async () => {
    const client = new GhCliGitHubClient('/tmp/checkout');
    await client.discardWorkingTreeChanges();

    expect(mockExecuteCommand).toHaveBeenCalledTimes(2);
    expect(mockExecuteCommand.mock.calls[0]).toEqual([
      'git', ['reset', '--hard', 'HEAD'], { cwd: '/tmp/checkout' },
    ]);
    expect(mockExecuteCommand.mock.calls[1]).toEqual([
      'git', ['clean', '-fd'], { cwd: '/tmp/checkout' },
    ]);
  });

  it('forwards exclude patterns to `git clean -e`', async () => {
    const client = new GhCliGitHubClient('/tmp/checkout');
    await client.discardWorkingTreeChanges(['.generacy']);

    const [, cleanArgs] = mockExecuteCommand.mock.calls[1]!;
    expect(cleanArgs).toEqual(['clean', '-fd', '-e', '.generacy']);
  });

  it('throws when the reset fails and never runs clean', async () => {
    mockExecuteCommand.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'reset boom' });
    const client = new GhCliGitHubClient('/tmp/checkout');

    await expect(client.discardWorkingTreeChanges(['.generacy'])).rejects.toThrow(
      /Failed to reset working tree: reset boom/,
    );
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
  });

  it('throws when the clean fails', async () => {
    mockExecuteCommand
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'clean boom' });
    const client = new GhCliGitHubClient('/tmp/checkout');

    await expect(client.discardWorkingTreeChanges()).rejects.toThrow(
      /Failed to clean working tree: clean boom/,
    );
  });
});
