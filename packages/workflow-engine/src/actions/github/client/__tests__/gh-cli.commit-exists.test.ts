/**
 * Unit tests for GhCliGitHubClient.commitExistsInCheckout (#1112 FR-003).
 *
 * Covers the contract in specs/1112-follow-up-1107-pr/contracts/git-client.md:
 *   - git exit 0 → true (commit exists)
 *   - git exit 1 → false (commit-missing, full or abbreviated sha)
 *   - any other exit (e.g. 128) → throw with exit code + stderr in the message
 *   - runs `git rev-parse --verify --quiet <sha>^{commit}` in this.workdir
 *
 * The exit-1-vs-128 split is load-bearing: exit 1 is treated as "re-capture"
 * by the phase-loop guard, while exit 128 must surface as a detection failure
 * (SC-005) rather than silently re-capturing an environment fault as absent.
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

describe('GhCliGitHubClient.commitExistsInCheckout', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  it('returns true when git rev-parse exits 0', async () => {
    mockExecuteCommand.mockResolvedValue({ exitCode: 0, stdout: 'abc123\n', stderr: '' });
    const client = new GhCliGitHubClient('/tmp/checkout');
    await expect(client.commitExistsInCheckout('abc1234')).resolves.toBe(true);
  });

  it('returns false when git rev-parse exits 1 (commit-missing)', async () => {
    mockExecuteCommand.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    const client = new GhCliGitHubClient('/tmp/checkout');
    await expect(client.commitExistsInCheckout('deadbeef')).resolves.toBe(false);
  });

  it('throws when git rev-parse exits 128 (environment fault)', async () => {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    });
    const client = new GhCliGitHubClient('/tmp/checkout');
    await expect(client.commitExistsInCheckout('abc1234')).rejects.toThrow(
      /git rev-parse --verify --quiet abc1234\^\{commit\} failed \(exit 128\): fatal: not a git repository/,
    );
  });

  it('runs `git rev-parse --verify --quiet <sha>^{commit}` in this.workdir', async () => {
    mockExecuteCommand.mockResolvedValue({ exitCode: 0, stdout: 'abc123\n', stderr: '' });
    const client = new GhCliGitHubClient('/tmp/checkout');
    await client.commitExistsInCheckout('abc1234');

    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = mockExecuteCommand.mock.calls[0]!;
    expect(cmd).toBe('git');
    expect(args).toEqual(['rev-parse', '--verify', '--quiet', 'abc1234^{commit}']);
    expect(opts).toEqual({ cwd: '/tmp/checkout' });
  });
});
