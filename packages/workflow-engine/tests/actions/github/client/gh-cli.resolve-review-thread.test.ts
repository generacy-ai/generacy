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

describe('GhCliGitHubClient.resolveReviewThread (#883)', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
    vi.useFakeTimers();
  });

  it('happy path — single success, correct wire args', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'PRRT_abc', isResolved: true } } } }),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    await client.resolveReviewThread('PRRT_abc');

    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockExecuteCommand.mock.calls[0]!;
    expect(cmd).toBe('gh');
    expect(args).toEqual([
      'api', 'graphql',
      '-f',
      'query=mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }',
      '-F', 'id=PRRT_abc',
    ]);
  });

  it('transient retry — 2 fails then success (3 calls total)', async () => {
    mockExecuteCommand
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'HTTP 500 transient' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'HTTP 502 transient' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'PRRT_x', isResolved: true } } } }),
        stderr: '',
      });

    const client = new GhCliGitHubClient('/tmp');
    const promise = client.resolveReviewThread('PRRT_x');
    // advance through the 1s and 2s backoffs
    await vi.runAllTimersAsync();
    await promise;

    expect(mockExecuteCommand).toHaveBeenCalledTimes(3);
  });

  it('persistent transient — 3 fails, throws with last stderr in message', async () => {
    mockExecuteCommand
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'HTTP 500 first' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'HTTP 502 second' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'HTTP 503 last' });

    const client = new GhCliGitHubClient('/tmp');
    const promise = client.resolveReviewThread('PRRT_stuck');
    // Attach rejection handler BEFORE running timers so no unhandled-rejection
    // warning fires while the retry loop settles.
    const assertion = expect(promise).rejects.toThrow(/HTTP 503 last/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockExecuteCommand).toHaveBeenCalledTimes(3);
  });

  it('GhAuthError passthrough — 1 call, no retry', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 1, stdout: '', stderr: 'HTTP 401: Bad credentials',
    });

    const client = new GhCliGitHubClient('/tmp');
    const promise = client.resolveReviewThread('PRRT_auth');
    const assertion = expect(promise).rejects.toBeInstanceOf(GhAuthError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
  });

  it('GraphQL-level errors on 200 — 1 call, no retry, throws', async () => {
    mockExecuteCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ errors: [{ message: 'Could not resolve to a node' }] }),
      stderr: '',
    });

    const client = new GhCliGitHubClient('/tmp');
    const promise = client.resolveReviewThread('PRRT_deleted');
    const assertion = expect(promise).rejects.toThrow(/Could not resolve to a node/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
  });
});
