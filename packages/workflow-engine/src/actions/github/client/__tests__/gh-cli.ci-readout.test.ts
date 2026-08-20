/**
 * Unit tests for GhCliGitHubClient.getCiRunsForSha (#1133 T005/T006).
 *
 * Covers specs/1133-context-repo-ci-yml/contracts/gh-cli-ci-readout.md:
 *   - primary check-runs path yields runs + source 'check-runs'
 *   - fallback actions/runs path triggered on non-zero primary exit,
 *     filtered to the head SHA, source 'actions-runs'
 *   - the SAME real CI state yields an IDENTICAL verdict across both paths (SC-004)
 *   - empty result → runs: [] → aggregation yields 'pending'
 *   - both paths non-zero → throws with stderr
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
import { aggregateCiVerdict } from '../ci-verdict.js';

const mockExecuteCommand = vi.mocked(executeCommand);

/** jq stream output for check-runs: one {status, conclusion} object per line. */
function checkRunsStream(
  runs: Array<{ status: string; conclusion: string | null }>,
): string {
  return runs.map((r) => JSON.stringify(r)).join('\n');
}

/** jq stream output for actions/runs: adds head_sha per object. */
function actionsRunsStream(
  runs: Array<{ head_sha: string; status: string; conclusion: string | null }>,
): string {
  return runs.map((r) => JSON.stringify(r)).join('\n');
}

describe('GhCliGitHubClient.getCiRunsForSha', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  it('primary check-runs path returns normalized runs + source check-runs', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: checkRunsStream([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'skipped' },
      ]),
      stderr: '',
    });
    const client = new GhCliGitHubClient('/tmp');
    const result = await client.getCiRunsForSha('o', 'r', 'sha123', 'feature');

    expect(result.source).toBe('check-runs');
    expect(result.runs).toEqual([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'skipped' },
    ]);
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockExecuteCommand.mock.calls[0]!;
    expect(cmd).toBe('gh');
    expect(args).toEqual(
      expect.arrayContaining(['api', 'repos/o/r/commits/sha123/check-runs']),
    );
  });

  it('falls back to actions/runs on non-zero primary exit, filtered to head SHA', async () => {
    mockExecuteCommand
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'HTTP 403' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: actionsRunsStream([
          { head_sha: 'sha123', status: 'completed', conclusion: 'success' },
          { head_sha: 'other', status: 'completed', conclusion: 'failure' },
          { head_sha: 'sha123', status: 'completed', conclusion: 'skipped' },
        ]),
        stderr: '',
      });
    const client = new GhCliGitHubClient('/tmp');
    const result = await client.getCiRunsForSha('o', 'r', 'sha123', 'feature');

    expect(result.source).toBe('actions-runs');
    expect(result.runs).toEqual([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'skipped' },
    ]);
    expect(mockExecuteCommand).toHaveBeenCalledTimes(2);
    const [, fallbackArgs] = mockExecuteCommand.mock.calls[1]!;
    expect(fallbackArgs).toEqual(
      expect.arrayContaining([
        'api',
        'repos/o/r/actions/runs?branch=feature&per_page=100',
      ]),
    );
  });

  it('yields an identical verdict across both paths for the same real CI state (SC-004)', async () => {
    // Same underlying state: one success + one skipped → green.
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: checkRunsStream([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'skipped' },
      ]),
      stderr: '',
    });
    const client = new GhCliGitHubClient('/tmp');
    const primary = await client.getCiRunsForSha('o', 'r', 'sha123', 'feature');

    mockExecuteCommand.mockReset();
    mockExecuteCommand
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no checks:read' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: actionsRunsStream([
          { head_sha: 'sha123', status: 'completed', conclusion: 'success' },
          { head_sha: 'sha123', status: 'completed', conclusion: 'skipped' },
        ]),
        stderr: '',
      });
    const fallback = await client.getCiRunsForSha('o', 'r', 'sha123', 'feature');

    expect(aggregateCiVerdict(primary.runs)).toBe(
      aggregateCiVerdict(fallback.runs),
    );
    expect(aggregateCiVerdict(primary.runs)).toBe('green');
  });

  it('empty check-runs result → runs [] → aggregation pending', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    const client = new GhCliGitHubClient('/tmp');
    const result = await client.getCiRunsForSha('o', 'r', 'sha123', 'feature');

    expect(result.runs).toEqual([]);
    expect(aggregateCiVerdict(result.runs)).toBe('pending');
  });

  it('no matching actions/runs for the SHA → runs [] → pending', async () => {
    mockExecuteCommand
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'HTTP 403' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: actionsRunsStream([
          { head_sha: 'other', status: 'completed', conclusion: 'success' },
        ]),
        stderr: '',
      });
    const client = new GhCliGitHubClient('/tmp');
    const result = await client.getCiRunsForSha('o', 'r', 'sha123', 'feature');

    expect(result.runs).toEqual([]);
    expect(aggregateCiVerdict(result.runs)).toBe('pending');
  });

  it('throws with both stderrs when both paths exit non-zero', async () => {
    mockExecuteCommand
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'primary boom' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'fallback boom' });
    const client = new GhCliGitHubClient('/tmp');
    await expect(
      client.getCiRunsForSha('o', 'r', 'sha123', 'feature'),
    ).rejects.toThrow(/failed on both paths/);
  });
});
