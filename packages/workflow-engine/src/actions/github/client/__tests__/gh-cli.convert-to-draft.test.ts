/**
 * Unit tests for GhCliGitHubClient.convertPullRequestToDraft (#1125 T008).
 *
 * Covers contracts/github-client-methods.md §convertPullRequestToDraft:
 *   - isDraft:true short-circuits (no mutation call)
 *   - isDraft:false runs the mutation
 *   - GraphQL errors[] throws terminally (no retry)
 *   - GhAuthError rethrown
 *   - transient failure retried
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

const queryResult = (id: string, isDraft: boolean) => ({
  exitCode: 0,
  stdout: JSON.stringify({ data: { repository: { pullRequest: { id, isDraft } } } }),
  stderr: '',
});

/** True iff the call args are the mutation (not the resolve query). */
const isMutationCall = (args: string[]) =>
  args.some(a => typeof a === 'string' && a.includes('convertPullRequestToDraft(input'));

describe('GhCliGitHubClient.convertPullRequestToDraft', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
    vi.useRealTimers();
  });

  it('short-circuits when the PR is already a draft (no mutation call)', async () => {
    mockExecuteCommand.mockResolvedValueOnce(queryResult('PR_node', true));

    const client = new GhCliGitHubClient('/tmp');
    await client.convertPullRequestToDraft('o', 'r', 42);

    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    expect(mockExecuteCommand.mock.calls.some(c => isMutationCall(c[1]))).toBe(false);
  });

  it('runs the mutation when the PR is ready (isDraft:false)', async () => {
    mockExecuteCommand
      .mockResolvedValueOnce(queryResult('PR_node', false))
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ data: {} }), stderr: '' });

    const client = new GhCliGitHubClient('/tmp');
    await client.convertPullRequestToDraft('o', 'r', 42);

    expect(mockExecuteCommand).toHaveBeenCalledTimes(2);
    expect(isMutationCall(mockExecuteCommand.mock.calls[1]![1])).toBe(true);
  });

  it('throws terminally on GraphQL errors[] in the mutation (no retry)', async () => {
    mockExecuteCommand
      .mockResolvedValueOnce(queryResult('PR_node', false))
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ errors: [{ message: 'permission denied' }] }),
        stderr: '',
      });

    const client = new GhCliGitHubClient('/tmp');
    await expect(client.convertPullRequestToDraft('o', 'r', 42)).rejects.toThrow(/permission denied/);
    expect(mockExecuteCommand).toHaveBeenCalledTimes(2); // no retry
  });

  it('rethrows GhAuthError from the mutation without retry', async () => {
    mockExecuteCommand
      .mockResolvedValueOnce(queryResult('PR_node', false))
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' });

    const client = new GhCliGitHubClient('/tmp');
    await expect(client.convertPullRequestToDraft('o', 'r', 42)).rejects.toMatchObject({
      name: 'GhAuthError',
    });
    expect(mockExecuteCommand).toHaveBeenCalledTimes(2); // no retry after auth failure
  });

  it('retries a transient mutation failure then succeeds', async () => {
    vi.useFakeTimers();
    mockExecuteCommand
      .mockResolvedValueOnce(queryResult('PR_node', false))
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'HTTP 502: bad gateway' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ data: {} }), stderr: '' });

    const client = new GhCliGitHubClient('/tmp');
    const promise = client.convertPullRequestToDraft('o', 'r', 42);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(promise).resolves.toBeUndefined();
    expect(mockExecuteCommand).toHaveBeenCalledTimes(3);
  });
});
