/**
 * Unit tests for GhCliGitHubClient.listPullRequestFiles (#1125 T009).
 *
 * Covers contracts/github-client-methods.md §listPullRequestFiles:
 *   - paginated REST path
 *   - parses `patch`
 *   - tolerates missing `patch` (binary/too-large files)
 *   - non-zero exit throws
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

describe('GhCliGitHubClient.listPullRequestFiles', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  it('uses the paginated files path and parses patch, tolerating missing patch', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify([
        { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,2 +1,3 @@\n+new' },
        { filename: 'img/logo.png', status: 'added' },
      ]),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const files = await client.listPullRequestFiles('o', 'r', 42);

    const args = mockExecuteCommand.mock.calls[0]![1];
    expect(args).toContain('/repos/o/r/pulls/42/files?per_page=100');
    expect(args).toContain('--paginate');

    expect(files).toEqual([
      { filename: 'src/a.ts', status: 'modified', patch: '@@ -1,2 +1,3 @@\n+new' },
      { filename: 'img/logo.png', status: 'added' },
    ]);
  });

  it('returns [] on empty response', async () => {
    mockExecuteCommand.mockResolvedValue({ exitCode: 0, stdout: '[]', stderr: '' });
    const client = new GhCliGitHubClient('/tmp');
    await expect(client.listPullRequestFiles('o', 'r', 42)).resolves.toEqual([]);
  });

  it('throws with stderr on non-zero exit', async () => {
    mockExecuteCommand.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'not found' });
    const client = new GhCliGitHubClient('/tmp');
    await expect(client.listPullRequestFiles('o', 'r', 42)).rejects.toThrow(/Failed to list files.*not found/);
  });
});
