import { describe, expect, it, vi } from 'vitest';
import { GhCliWrapper } from '../gh/wrapper.js';
import { createGhResponseCache } from '../gh/cache.js';
import type { CommandRunner, CommandResult } from '../gh/command-runner.js';

function scriptedRunner(
  responder: (cmd: string, args: string[]) => Partial<CommandResult>,
): { runner: CommandRunner; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const runner: CommandRunner = vi.fn(async (cmd, args) => {
    calls.push({ cmd, args });
    const partial = responder(cmd, args);
    return {
      stdout: partial.stdout ?? '[]',
      stderr: partial.stderr ?? '',
      exitCode: partial.exitCode ?? 0,
    };
  });
  return { runner, calls };
}

const CHECK_RUNS_JSON = JSON.stringify([
  { name: 'ci', state: 'SUCCESS' },
]);
const ISSUE_JSON = JSON.stringify({
  number: 42,
  title: 'x',
  state: 'OPEN',
  labels: [],
  url: 'https://github.com/o/r/issues/42',
});
const PR_JSON = JSON.stringify({
  number: 7,
  state: 'OPEN',
  url: 'https://github.com/o/r/pull/7',
  isDraft: false,
  labels: [],
  headRefOid: 'sha1',
});

describe('GhCliWrapper cache integration', () => {
  it('serves getPullRequestCheckRuns from cache within TTL', async () => {
    const { runner, calls } = scriptedRunner(() => ({
      stdout: CHECK_RUNS_JSON,
    }));
    const cache = createGhResponseCache();
    const gh = new GhCliWrapper(runner, undefined, { cache });

    await gh.getPullRequestCheckRuns('o/r', 7);
    await gh.getPullRequestCheckRuns('o/r', 7);
    const checkCalls = calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'checks');
    expect(checkCalls).toHaveLength(1);
  });

  it('addLabels invalidates the paired getIssue key', async () => {
    const { runner, calls } = scriptedRunner((_cmd, args) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: ISSUE_JSON };
      }
      return {};
    });
    const cache = createGhResponseCache();
    const gh = new GhCliWrapper(runner, undefined, { cache });

    await gh.getIssue('o/r', 42);
    await gh.addLabels('o/r', 42, ['x']);
    await gh.getIssue('o/r', 42);

    const viewCalls = calls.filter(
      (c) => c.args[0] === 'issue' && c.args[1] === 'view',
    );
    expect(viewCalls).toHaveLength(2);
  });

  it('mergePullRequest invalidates paired PR + check-runs keys', async () => {
    const { runner, calls } = scriptedRunner((_cmd, args) => {
      if (args[0] === 'pr' && args[1] === 'view') return { stdout: PR_JSON };
      if (args[0] === 'pr' && args[1] === 'checks') return { stdout: CHECK_RUNS_JSON };
      if (args[0] === 'pr' && args[1] === 'merge') return { stdout: '' };
      return {};
    });
    const cache = createGhResponseCache();
    const gh = new GhCliWrapper(runner, undefined, { cache });

    await gh.getPullRequest('o/r', 7);
    await gh.getPullRequestCheckRuns('o/r', 7);
    await gh.mergePullRequest('o/r', 7, { squash: true });
    await gh.getPullRequest('o/r', 7);
    await gh.getPullRequestCheckRuns('o/r', 7);

    const prViewCalls = calls.filter(
      (c) =>
        c.args[0] === 'pr' &&
        c.args[1] === 'view' &&
        c.args.some((a) => a.includes('headRefOid')),
    );
    expect(prViewCalls).toHaveLength(2);
    const checkCalls = calls.filter(
      (c) => c.args[0] === 'pr' && c.args[1] === 'checks',
    );
    expect(checkCalls).toHaveLength(2);
  });

  it('bare wrapper (no options) does not cache — regression witness', async () => {
    const { runner, calls } = scriptedRunner(() => ({ stdout: CHECK_RUNS_JSON }));
    const gh = new GhCliWrapper(runner);
    await gh.getPullRequestCheckRuns('o/r', 7);
    await gh.getPullRequestCheckRuns('o/r', 7);
    const checkCalls = calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'checks');
    expect(checkCalls).toHaveLength(2);
  });
});
