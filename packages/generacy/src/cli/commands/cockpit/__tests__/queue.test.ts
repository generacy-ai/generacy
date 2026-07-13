import { describe, it, expect, vi } from 'vitest';
import { runQueue, runQueueSingleIssue } from '../queue.js';
import { CockpitExit } from '../exit.js';
import { FakeGh } from './helpers/fake-gh.js';
import type { CommandRunner, GhWrapper, IssueStateResult } from '@generacy-ai/cockpit';

interface IssueSeed {
  state?: 'OPEN' | 'CLOSED';
  labels?: string[];
  assignees?: string[];
  title?: string;
  notFound?: boolean;
}

function stubGhWrapper(
  states: Record<string, IssueSeed> = {},
  overrides: Partial<GhWrapper> = {},
): GhWrapper {
  return {
    fetchIssueLabels: vi.fn(),
    fetchIssueState: vi.fn(async (repo: string, n: number): Promise<IssueStateResult> => {
      const seed = states[`${repo}#${n}`];
      if (seed?.notFound) throw new Error('not found');
      return {
        state: seed?.state ?? 'OPEN',
        closedAt: null,
        labels: seed?.labels ?? [],
        assignees: seed?.assignees ?? [],
        title: seed?.title ?? `Issue ${n}`,
      };
    }),
    postIssueComment: vi.fn(),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(),
    addAssignees: vi.fn(async () => {}),
    fetchIssueTimeline: vi.fn(),
    fetchIssueComments: vi.fn(),
    getCurrentUser: vi.fn(async () => 'octocat'),
    findOpenPrForBranch: vi.fn(),
    prDiffNames: vi.fn(),
    prDiffPatch: vi.fn(),
    ...overrides,
  } as GhWrapper;
}

function epicBody(phases: Array<{ heading: string; refs: string[] }>): string {
  const lines: string[] = [];
  for (const phase of phases) {
    lines.push(`### ${phase.heading}`);
    for (const ref of phase.refs) lines.push(`- [ ] ${ref}`);
    lines.push('');
  }
  return lines.join('\n');
}

function ghWithBody(body: string): FakeGh {
  return new FakeGh({
    bodyByIssue: { 'owner/epic#42': body },
  });
}

describe('runQueue', () => {
  it('labels every ref under `### S2 …`', async () => {
    const body = epicBody([
      { heading: 'S1 alpha', refs: ['owner/repo#101'] },
      { heading: 'S2 cohort', refs: ['owner/repo#201', 'owner/repo#202'] },
    ]);
    const gh = ghWithBody(body);
    const cockpitGh = stubGhWrapper();
    const out: string[] = [];

    const result = await runQueue(
      'owner/epic#42',
      's2',
      { yes: true },
      { gh, cockpitGh, stdout: (l) => out.push(l) },
    );

    expect(result.phase.heading).toBe('S2 cohort');
    expect(result.rows.map((r) => `${r.ref.repo}#${r.ref.number}`)).toEqual([
      'owner/repo#201',
      'owner/repo#202',
    ]);
    expect(result.exitCode).toBe(0);
    expect(cockpitGh.addLabel).toHaveBeenCalledTimes(2);
    expect(cockpitGh.addAssignees).toHaveBeenCalledTimes(2);
  });

  it('--label overrides the default process:speckit-feature', async () => {
    const body = epicBody([{ heading: 'S1', refs: ['owner/repo#1'] }]);
    const gh = ghWithBody(body);
    const cockpitGh = stubGhWrapper();
    const out: string[] = [];

    const result = await runQueue(
      'owner/epic#42',
      's1',
      { yes: true, label: 'process:speckit-bugfix' },
      { gh, cockpitGh, stdout: (l) => out.push(l) },
    );

    expect(result.workflowLabel).toBe('process:speckit-bugfix');
    expect(cockpitGh.addLabel).toHaveBeenCalledWith('owner/repo', 1, 'process:speckit-bugfix');
  });

  it('skips closed refs at preview', async () => {
    const body = epicBody([{ heading: 'S1', refs: ['owner/repo#1', 'owner/repo#2'] }]);
    const gh = ghWithBody(body);
    const cockpitGh = stubGhWrapper({
      'owner/repo#1': { state: 'CLOSED' },
    });
    const out: string[] = [];

    const result = await runQueue(
      'owner/epic#42',
      's1',
      { yes: true },
      { gh, cockpitGh, stdout: (l) => out.push(l) },
    );

    expect(result.rows.find((r) => r.ref.number === 1)?.eligibility.kind).toBe('skip');
    expect(result.rows.find((r) => r.ref.number === 2)?.eligibility.kind).toBe('eligible');
    expect(out.some((l) => l.includes('[SKIP: closed]'))).toBe(true);
  });

  it('skips refs already carrying the workflow label', async () => {
    const body = epicBody([{ heading: 'S1', refs: ['owner/repo#1'] }]);
    const gh = ghWithBody(body);
    const cockpitGh = stubGhWrapper({
      'owner/repo#1': { labels: ['process:speckit-feature'] },
    });
    const out: string[] = [];

    const result = await runQueue(
      'owner/epic#42',
      's1',
      { yes: true },
      { gh, cockpitGh, stdout: (l) => out.push(l) },
    );

    expect(result.rows[0]?.eligibility.kind).toBe('skip');
    if (result.rows[0]?.eligibility.kind === 'skip') {
      expect(result.rows[0].eligibility.reason).toBe('already-labeled');
    }
  });

  it('ambiguous <phase> exits 2 and lists candidates', async () => {
    const body = epicBody([
      { heading: 'S1 alpha', refs: ['owner/repo#1'] },
      { heading: 'S1 beta', refs: ['owner/repo#2'] },
    ]);
    const gh = ghWithBody(body);
    const cockpitGh = stubGhWrapper();

    await expect(
      runQueue('owner/epic#42', 's1', { yes: true }, { gh, cockpitGh }),
    ).rejects.toMatchObject({ code: 2 });
    try {
      await runQueue('owner/epic#42', 's1', { yes: true }, { gh, cockpitGh });
    } catch (err) {
      expect(err).toBeInstanceOf(CockpitExit);
      const cx = err as CockpitExit;
      expect(cx.message).toContain('S1 alpha');
      expect(cx.message).toContain('S1 beta');
    }
  });

  it('unknown <phase> exits 2 with candidate headings', async () => {
    const body = epicBody([{ heading: 'S1', refs: ['owner/repo#1'] }]);
    const gh = ghWithBody(body);
    const cockpitGh = stubGhWrapper();

    try {
      await runQueue('owner/epic#42', 's9', { yes: true }, { gh, cockpitGh });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CockpitExit);
      const cx = err as CockpitExit;
      expect(cx.code).toBe(2);
      expect(cx.message).toContain('S1');
    }
  });

  it('malformed <epic-ref> exits 2', async () => {
    const gh = new FakeGh({});
    const cockpitGh = stubGhWrapper();
    try {
      await runQueue('not-a-ref', 's1', { yes: true }, { gh, cockpitGh });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CockpitExit);
      expect((err as CockpitExit).code).toBe(2);
    }
  });

  it('bare number <epic-ref> resolves via injected runner (US2 + US3 regression)', async () => {
    const body = epicBody([{ heading: 'S1', refs: ['owner/repo#201'] }]);
    const gh = new FakeGh({
      bodyByIssue: { 'owner/repo#1': body },
    });
    const cockpitGh = stubGhWrapper();
    const runner: CommandRunner = vi.fn(async () => ({
      stdout: 'https://github.com/owner/repo.git\n',
      stderr: '',
      exitCode: 0,
    }));

    const result = await runQueue(
      '1',
      's1',
      { yes: true },
      { gh, cockpitGh, runner },
    );

    expect(runner).toHaveBeenCalledTimes(1);
    expect(result.epic.epic.repo).toBe('owner/repo');
    expect(result.epic.epic.number).toBe(1);
    expect(result.exitCode).toBe(0);
  });

  it('owner/repo#N form continues to work identically (FR-005, FR-009)', async () => {
    const body = epicBody([{ heading: 'S1', refs: ['owner/repo#201'] }]);
    const gh = new FakeGh({
      bodyByIssue: { 'owner/epic#123': body },
    });
    const cockpitGh = stubGhWrapper();

    const result = await runQueue(
      'owner/epic#123',
      's1',
      { yes: true },
      { gh, cockpitGh },
    );

    expect(result.epic.epic.repo).toBe('owner/epic');
    expect(result.epic.epic.number).toBe(123);
    expect(result.exitCode).toBe(0);
  });

  it('App-credentialed cluster resolves identity from CLUSTER_GITHUB_USERNAME (no gh api user)', async () => {
    const body = epicBody([{ heading: 'S1', refs: ['owner/repo#201'] }]);
    const gh = ghWithBody(body);
    const throwingGetUser = vi.fn(async () => {
      throw new Error('HTTP 403: Resource not accessible by integration');
    });
    const cockpitGh = stubGhWrapper({}, { getCurrentUser: throwingGetUser });
    const loadConfig = vi.fn(async () => ({
      config: {},
      source: 'defaults' as const,
      warnings: [],
    }));

    const result = await runQueue(
      'owner/epic#42',
      's1',
      { yes: true },
      {
        gh,
        cockpitGh,
        loadConfig,
        env: { CLUSTER_GITHUB_USERNAME: 'cluster-bot' },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.assignee).toBe('cluster-bot');
    expect(throwingGetUser).not.toHaveBeenCalled();
    expect(cockpitGh.addAssignees).toHaveBeenCalledWith('owner/repo', 201, ['cluster-bot']);
  });

  it('all identity sources miss → CockpitExit(1, ...) with the 4-knob message (SC-004)', async () => {
    const body = epicBody([{ heading: 'S1', refs: ['owner/repo#201'] }]);
    const gh = ghWithBody(body);
    const throwingGetUser = vi.fn(async () => {
      throw new Error('gh api user: 403 forbidden');
    });
    const cockpitGh = stubGhWrapper({}, { getCurrentUser: throwingGetUser });
    const loadConfig = vi.fn(async () => ({
      config: {},
      source: 'defaults' as const,
      warnings: [],
    }));

    let caught: unknown;
    try {
      await runQueue(
        'owner/epic#42',
        's1',
        { yes: true },
        {
          gh,
          cockpitGh,
          loadConfig,
          env: {},
        },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CockpitExit);
    const cx = caught as CockpitExit;
    expect(cx.code).toBe(1);
    expect(cx.message).toContain('--assignee');
    expect(cx.message).toContain('cockpit.assignee');
    expect(cx.message).toContain('CLUSTER_GITHUB_USERNAME');
    expect(cx.message).toContain('GH_USERNAME');
  });
});

describe('runQueueSingleIssue (#935)', () => {
  const loadConfig = vi.fn(async () => ({
    config: { assignee: 'octocat' },
    source: 'defaults' as const,
    warnings: [],
  }));

  it('happy path: eligible → applies assignee + label, exit 0', async () => {
    const cockpitGh = stubGhWrapper({});
    const out: string[] = [];
    const result = await runQueueSingleIssue(
      'owner/repo#7',
      { yes: true },
      { cockpitGh, loadConfig, stdout: (l) => out.push(l), env: {} },
    );
    expect(result.exitCode).toBe(0);
    expect(result.row.eligibility.kind).toBe('eligible');
    expect(cockpitGh.addLabel).toHaveBeenCalledWith('owner/repo', 7, 'process:speckit-feature');
    expect(cockpitGh.addAssignees).toHaveBeenCalledWith('owner/repo', 7, ['octocat']);
    expect(out.some((l) => l.includes('cockpit queue --issue'))).toBe(true);
  });

  it('closed issue → skipped, no mutation, exit 0', async () => {
    const cockpitGh = stubGhWrapper({
      'owner/repo#7': { state: 'CLOSED' },
    });
    const out: string[] = [];
    const result = await runQueueSingleIssue(
      'owner/repo#7',
      { yes: true },
      { cockpitGh, loadConfig, stdout: (l) => out.push(l), env: {} },
    );
    expect(result.exitCode).toBe(0);
    expect(result.row.eligibility.kind).toBe('skip');
    if (result.row.eligibility.kind === 'skip') {
      expect(result.row.eligibility.reason).toBe('closed');
    }
    expect(cockpitGh.addLabel).not.toHaveBeenCalled();
    expect(cockpitGh.addAssignees).not.toHaveBeenCalled();
  });

  it('already-labeled → skipped', async () => {
    const cockpitGh = stubGhWrapper({
      'owner/repo#7': { labels: ['process:speckit-feature'] },
    });
    const result = await runQueueSingleIssue(
      'owner/repo#7',
      { yes: true },
      { cockpitGh, loadConfig, stdout: () => {}, env: {} },
    );
    expect(result.row.eligibility.kind).toBe('skip');
    if (result.row.eligibility.kind === 'skip') {
      expect(result.row.eligibility.reason).toBe('already-labeled');
    }
  });

  it('not-found → skipped', async () => {
    const cockpitGh = stubGhWrapper({
      'owner/repo#7': { notFound: true },
    });
    const result = await runQueueSingleIssue(
      'owner/repo#7',
      { yes: true },
      { cockpitGh, loadConfig, stdout: () => {}, env: {} },
    );
    expect(result.row.eligibility.kind).toBe('skip');
    if (result.row.eligibility.kind === 'skip') {
      expect(result.row.eligibility.reason).toBe('not-found');
    }
  });

  it('malformed ref → CockpitExit(2)', async () => {
    let thrown: unknown = null;
    try {
      await runQueueSingleIssue(
        'garbage-ref',
        { yes: true },
        { cockpitGh: stubGhWrapper(), loadConfig, stdout: () => {}, env: {} },
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CockpitExit);
    expect((thrown as CockpitExit).code).toBe(2);
  });
});
