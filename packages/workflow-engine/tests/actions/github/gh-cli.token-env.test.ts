import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/actions/cli-utils.js', () => ({
  executeCommand: vi.fn(),
  parseJSONSafe: vi.fn((input: string) => {
    try { return JSON.parse(input); } catch { return null; }
  }),
}));

import { executeCommand } from '../../../src/actions/cli-utils.js';
import { GhCliGitHubClient } from '../../../src/actions/github/client/gh-cli.js';

const mockExecuteCommand = vi.mocked(executeCommand);

/**
 * #777 — Tests for the resolveTokenEnv invariant:
 *   - provider present ⇒ GH_TOKEN is ALWAYS set in env override (never undefined)
 *   - provider throws ⇒ env-override never constructed (no `gh` spawn)
 *   - no provider ⇒ env override is undefined (legacy ambient inheritance)
 *
 * Note: `resolveTokenEnv` is private — we exercise it via `executeGh` (any
 * public method works; we use `getRepoInfo` since it makes a single gh call)
 * and inspect the `env` option passed to `executeCommand`.
 */
describe('GhCliGitHubClient resolveTokenEnv invariant (#777)', () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  function mockGhSuccess() {
    mockExecuteCommand.mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify({ owner: { login: 'o' }, name: 'r', defaultBranchRef: { name: 'main' } }),
      stderr: '',
    });
  }

  it('resolveTokenEnv returns { GH_TOKEN } when provider returns a token', async () => {
    mockGhSuccess();
    const tokenProvider = vi.fn(async () => 'ghs_fresh');
    const client = new GhCliGitHubClient('/tmp', tokenProvider);

    await client.getRepoInfo();

    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    const callArgs = mockExecuteCommand.mock.calls[0]!;
    const opts = callArgs[2] as { env?: Record<string, string> };
    expect(opts.env).toEqual({ GH_TOKEN: 'ghs_fresh' });
  });

  it('resolveTokenEnv returns { GH_TOKEN: "" } when provider returns undefined', async () => {
    mockGhSuccess();
    const tokenProvider = vi.fn(async () => undefined);
    const client = new GhCliGitHubClient('/tmp', tokenProvider);

    await client.getRepoInfo();

    const callArgs = mockExecuteCommand.mock.calls[0]!;
    const opts = callArgs[2] as { env?: Record<string, string> };
    expect(opts.env).toEqual({ GH_TOKEN: '' });
    // Explicit: NOT undefined — the whole point of the invariant is to defeat
    // ambient inheritance of process.env.GH_TOKEN.
    expect(opts.env).not.toBeUndefined();
  });

  it('resolveTokenEnv returns { GH_TOKEN: "" } when provider returns empty string', async () => {
    mockGhSuccess();
    const tokenProvider = vi.fn(async () => '');
    const client = new GhCliGitHubClient('/tmp', tokenProvider);

    await client.getRepoInfo();

    const callArgs = mockExecuteCommand.mock.calls[0]!;
    const opts = callArgs[2] as { env?: Record<string, string> };
    expect(opts.env).toEqual({ GH_TOKEN: '' });
  });

  it('resolveTokenEnv returns undefined when no provider configured (legacy behavior)', async () => {
    mockGhSuccess();
    const client = new GhCliGitHubClient('/tmp');

    await client.getRepoInfo();

    const callArgs = mockExecuteCommand.mock.calls[0]!;
    const opts = callArgs[2] as { env?: Record<string, string> };
    expect(opts.env).toBeUndefined();
  });

  it('executeGh propagates errors thrown by the tokenProvider; no gh subprocess spawned', async () => {
    const thrown = new Error('JIT token fetch failed');
    const tokenProvider = vi.fn(async () => {
      throw thrown;
    });
    const client = new GhCliGitHubClient('/tmp', tokenProvider);

    await expect(client.getRepoInfo()).rejects.toBe(thrown);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });
});
