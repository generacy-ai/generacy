import { describe, it, expect, vi } from 'vitest';
import { runQueue } from '../queue.js';
import { CockpitExit } from '../exit.js';
import { FakeGh } from './helpers/fake-gh.js';
import type { GhWrapper, IssueStateResult } from '@generacy-ai/cockpit';

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
});
