import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runWatch } from '../watch.js';
import { FakeGh } from './helpers/fake-gh.js';
import type { CommandRunner } from '@generacy-ai/cockpit';

function buildBody(refs: Array<{ repo: string; number: number }>): string {
  const lines = ['### S2 — cohort'];
  for (const r of refs) lines.push(`- [ ] ${r.repo}#${r.number}`);
  return lines.join('\n');
}

describe('cockpit watch', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrOut = '';

  beforeEach(() => {
    stderrOut = '';
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOut += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      return true;
    });
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  function makeStopper(after: number): {
    controller: AbortController;
    onTick: () => void;
  } {
    const controller = new AbortController();
    let ticks = 0;
    return {
      controller,
      onTick: () => {
        ticks += 1;
        if (ticks >= after) controller.abort();
      },
    };
  }

  it('re-resolves the epic body every tick — refs added mid-run join (SC-004)', async () => {
    const epicRef = 'owner/epic-repo#42';
    const bodies = [
      buildBody([{ repo: 'owner/repo-a', number: 1 }]),
      buildBody([
        { repo: 'owner/repo-a', number: 1 },
        { repo: 'owner/repo-a', number: 2 },
      ]),
      buildBody([
        { repo: 'owner/repo-a', number: 1 },
        { repo: 'owner/repo-a', number: 2 },
      ]),
    ];
    let epicCallIndex = 0;
    const queries: string[] = [];

    const gh = new FakeGh({
      getIssueBy: (repo, number) => {
        if (repo === 'owner/epic-repo' && number === 42) {
          const body = bodies[Math.min(epicCallIndex, bodies.length - 1)]!;
          epicCallIndex += 1;
          return {
            number,
            title: 'epic',
            state: 'OPEN',
            stateReason: null,
            labels: [],
            url: `https://github.com/${repo}/issues/${number}`,
            body,
            createdAt: '',
          };
        }
        return {
          number,
          title: `issue ${number}`,
          state: 'OPEN',
          stateReason: null,
          labels: [],
          url: `https://github.com/${repo}/issues/${number}`,
          body: '',
          createdAt: '',
        };
      },
      issuesByQuery: (query) => {
        queries.push(query);
        return [];
      },
    });

    const { controller, onTick } = makeStopper(2);
    await runWatch(
      epicRef,
      {},
      {
        gh,
        intervalOverride: 5,
        onTick,
        abortSignal: controller.signal,
        logger: { warn: () => {} },
      },
    );

    const tick1Queries = queries.filter((q) => q === 'repo:owner/repo-a 1');
    const tick2Queries = queries.filter((q) => q === 'repo:owner/repo-a 1 2');
    expect(tick1Queries.length).toBeGreaterThanOrEqual(1);
    expect(tick2Queries.length).toBeGreaterThanOrEqual(1);
  });

  it('--interval below floor emits one stderr clamp warning and continues (SC-006)', async () => {
    const epicRef = 'owner/epic#42';
    const body = buildBody([{ repo: 'owner/r', number: 1 }]);
    const gh = new FakeGh({
      getIssueBy: (repo, number) => ({
        number,
        title: '',
        state: 'OPEN',
        stateReason: null,
        labels: [],
        url: `https://github.com/${repo}/issues/${number}`,
        body,
        createdAt: '',
      }),
    });

    const { controller, onTick } = makeStopper(1);
    const exit = await runWatch(
      epicRef,
      { interval: '5000' },
      { gh, onTick, abortSignal: controller.signal },
    );
    expect(exit).toBe(0);
    const clampWarnings = stderrOut
      .split('\n')
      .filter((l) => l.includes('below floor 15000ms; clamping'));
    expect(clampWarnings).toHaveLength(1);
  });

  it('mid-run resolver error logs stderr and skips the tick without exiting', async () => {
    const epicRef = 'owner/epic#42';
    const goodBody = buildBody([{ repo: 'owner/r', number: 1 }]);
    let callIdx = 0;
    const gh = new FakeGh({
      getIssueBy: (repo, number) => {
        callIdx += 1;
        if (callIdx === 2) {
          throw new Error('transient network');
        }
        return {
          number,
          title: '',
          state: 'OPEN',
          stateReason: null,
          labels: [],
          url: `https://github.com/${repo}/issues/${number}`,
          body: goodBody,
          createdAt: '',
        };
      },
    });

    const { controller, onTick } = makeStopper(2);
    const exit = await runWatch(
      epicRef,
      {},
      { gh, intervalOverride: 5, onTick, abortSignal: controller.signal },
    );
    expect(exit).toBe(0);
    expect(stderrOut).toContain('cockpit watch: poll error:');
    expect(stderrOut).toContain('transient network');
  });

  it('startup NO_PHASE_HEADINGS exits 1 with expected-format message (SC-003)', async () => {
    const gh = new FakeGh({
      getIssueBy: (repo, number) => ({
        number,
        title: '',
        state: 'OPEN',
        stateReason: null,
        labels: [],
        url: `https://github.com/${repo}/issues/${number}`,
        body: 'no headings here',
        createdAt: '',
      }),
    });
    const exit = await runWatch('owner/epic#42', {}, { gh });
    expect(exit).toBe(1);
    expect(stderrOut).toContain("'### <phase>'");
    expect(stderrOut).toContain('- [ ] owner/repo#N');
  });

  it('malformed <epic-ref> exits 2 with parse issue error message', async () => {
    const gh = new FakeGh({});
    const exit = await runWatch('garbage', {}, { gh });
    expect(exit).toBe(2);
    expect(stderrOut).toContain(
      'cockpit watch: parse issue: unrecognized issue ref "garbage". ' +
        'Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.',
    );
  });

  it('missing <epic-ref> exits 2', async () => {
    const gh = new FakeGh({});
    const exit = await runWatch(undefined, {}, { gh });
    expect(exit).toBe(2);
    expect(stderrOut).toContain('cockpit watch: parse issue: issue argument is required');
  });

  it('bare number resolves via injected runner (US2)', async () => {
    const body = buildBody([{ repo: 'owner/r', number: 1 }]);
    const gh = new FakeGh({
      getIssueBy: (repo, number) => ({
        number,
        title: '',
        state: 'OPEN',
        stateReason: null,
        labels: [],
        url: `https://github.com/${repo}/issues/${number}`,
        body,
        createdAt: '',
      }),
    });
    const runner: CommandRunner = vi.fn(async () => ({
      stdout: 'https://github.com/owner/repo.git\n',
      stderr: '',
      exitCode: 0,
    }));
    const { controller, onTick } = makeStopper(1);
    const exit = await runWatch(
      '42',
      {},
      { gh, runner, intervalOverride: 5, onTick, abortSignal: controller.signal, logger: { warn: () => {} } },
    );
    expect(exit).toBe(0);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(stderrOut).toContain('cockpit watch: epic owner/repo#42');
  });

  it('per-poll invariant: bare-number inference runs exactly once across N poll intervals', async () => {
    const epicRef = '42';
    const body = buildBody([{ repo: 'owner/repo', number: 1 }]);
    const gh = new FakeGh({
      getIssueBy: (repo, number) => ({
        number,
        title: '',
        state: 'OPEN',
        stateReason: null,
        labels: [],
        url: `https://github.com/${repo}/issues/${number}`,
        body,
        createdAt: '',
      }),
    });
    const runner = vi.fn<CommandRunner>(async (cmd, args) => {
      expect(cmd).toBe('git');
      expect(args).toEqual(['remote', 'get-url', 'origin']);
      return {
        stdout: 'https://github.com/owner/repo.git\n',
        stderr: '',
        exitCode: 0,
      };
    });

    const N = 5;
    const { controller, onTick } = makeStopper(N);
    const exit = await runWatch(
      epicRef,
      {},
      { gh, runner, intervalOverride: 5, onTick, abortSignal: controller.signal, logger: { warn: () => {} } },
    );
    expect(exit).toBe(0);
    // FR-invariant: `git remote get-url origin` fires exactly once, not once per poll.
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
