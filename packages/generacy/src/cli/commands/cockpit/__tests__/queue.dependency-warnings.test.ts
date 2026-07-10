/**
 * Tests for the #864 plan.md dependency-warning integration in cockpit queue.
 *
 * Cover:
 * - warning rendered for an open dep
 * - warning rendered for a closed-unmerged dep
 * - no warning for a merged dep
 * - --yes proceeds unaffected by warnings (exit 0)
 * - missing plan.md silently skipped
 * - non-implement phases skip the check entirely
 */
import { describe, it, expect, vi } from 'vitest';
import { runQueue, type PlanFetcher } from '../queue.js';
import { FakeGh, fakeResolvedRef } from './helpers/fake-gh.js';
import type {
  GhWrapper,
  IssueStateResult,
  PullRequestRef,
  PullRequestRefResolution,
} from '@generacy-ai/cockpit';

interface IssueSeed {
  state?: 'OPEN' | 'CLOSED';
  stateReason?: 'COMPLETED' | 'NOT_PLANNED' | null;
  labels?: string[];
  assignees?: string[];
  title?: string;
  notFound?: boolean;
  prRef?: PullRequestRef | null;
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
        stateReason: seed?.stateReason ?? null,
        closedAt: null,
        labels: seed?.labels ?? [],
        assignees: seed?.assignees ?? [],
        title: seed?.title ?? `Issue ${n}`,
      };
    }),
    resolveIssueToPRRef: vi.fn(
      async (repo: string, n: number): Promise<PullRequestRefResolution> => {
        const seed = states[`${repo}#${n}`];
        // Resolver returns only OPEN non-draft PRs. Non-OPEN PRs are surfaced via
        // issue stateReason. Seeds with an OPEN prRef produce a `resolved` result;
        // any other seed reports as `unresolved`.
        if (seed?.prRef != null && seed.prRef.state === 'OPEN' && !seed.prRef.draft) {
          return fakeResolvedRef(seed.prRef);
        }
        return { kind: 'unresolved' };
      },
    ),
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

function makePlanFetcher(planMap: Record<string, string | null>): PlanFetcher {
  return async (ref) => {
    const key = `${ref.repo}#${ref.number}`;
    return planMap[key] ?? null;
  };
}

describe('runQueue — plan.md dependency warnings (#864)', () => {
  it('renders a warning line for an open (unresolved) dep', async () => {
    const body = epicBody([{ heading: 'implement', refs: ['owner/repo#3'] }]);
    const gh = ghWithBody(body);
    const cockpitGh = stubGhWrapper({
      // The dependency #2 exists but is open — should warn.
      'owner/repo#2': { state: 'OPEN', prRef: null },
    });
    const fetchPlan = makePlanFetcher({
      'owner/repo#3': 'depends on #2 must be merged first',
    });
    const out: string[] = [];

    const result = await runQueue(
      'owner/epic#42',
      'implement',
      { yes: true },
      { gh, cockpitGh, fetchPlan, stdout: (l) => out.push(l) },
    );

    const row3 = result.rows.find((r) => r.ref.number === 3);
    expect(row3?.dependencyWarnings).toBeDefined();
    expect(row3?.dependencyWarnings).toHaveLength(1);
    expect(row3?.dependencyWarnings?.[0]!.state).toBe('unresolved');
    expect(row3?.dependencyWarnings?.[0]!.ref.number).toBe(2);

    // Rendered indented warning line
    const warnLine = out.find((l) => l.includes('[WARN: depends-on'));
    expect(warnLine).toBeDefined();
    expect(warnLine).toContain('owner/repo#2 not yet merged');
  });

  it('renders a warning for a closed-but-unmerged PR (closed-unmerged)', async () => {
    const body = epicBody([{ heading: 'implement', refs: ['owner/repo#3'] }]);
    const gh = ghWithBody(body);
    const cockpitGh = stubGhWrapper({
      'owner/repo#2': {
        state: 'CLOSED',
        prRef: {
          number: 100,
          url: 'x',
          state: 'CLOSED',
          draft: false,
          headRefName: 'br',
        },
      },
    });
    const fetchPlan = makePlanFetcher({
      'owner/repo#3': 'depends on #2 must be merged first',
    });
    const out: string[] = [];

    const result = await runQueue(
      'owner/epic#42',
      'implement',
      { yes: true },
      { gh, cockpitGh, fetchPlan, stdout: (l) => out.push(l) },
    );

    const row3 = result.rows.find((r) => r.ref.number === 3);
    expect(row3?.dependencyWarnings).toHaveLength(1);
    expect(row3?.dependencyWarnings?.[0]!.state).toBe('closed-unmerged');
  });

  it('produces no warning for a merged dep', async () => {
    const body = epicBody([{ heading: 'implement', refs: ['owner/repo#3'] }]);
    const gh = ghWithBody(body);
    const cockpitGh = stubGhWrapper({
      'owner/repo#2': {
        state: 'CLOSED',
        // Merged deps close their linked issue with stateReason='COMPLETED'.
        stateReason: 'COMPLETED',
        prRef: {
          number: 100,
          url: 'x',
          state: 'MERGED',
          draft: false,
          headRefName: 'br',
        },
      },
    });
    const fetchPlan = makePlanFetcher({
      'owner/repo#3': 'depends on #2 must be merged first',
    });
    const out: string[] = [];

    const result = await runQueue(
      'owner/epic#42',
      'implement',
      { yes: true },
      { gh, cockpitGh, fetchPlan, stdout: (l) => out.push(l) },
    );

    const row3 = result.rows.find((r) => r.ref.number === 3);
    expect(row3?.dependencyWarnings ?? []).toEqual([]);
    expect(out.some((l) => l.includes('[WARN:'))).toBe(false);
  });

  it('--yes proceeds with exit 0 even when warnings are present', async () => {
    const body = epicBody([{ heading: 'implement', refs: ['owner/repo#3'] }]);
    const gh = ghWithBody(body);
    const cockpitGh = stubGhWrapper({
      'owner/repo#2': { state: 'OPEN', prRef: null },
    });
    const fetchPlan = makePlanFetcher({
      'owner/repo#3': 'depends on #2 must be merged first',
    });

    const result = await runQueue(
      'owner/epic#42',
      'implement',
      { yes: true },
      { gh, cockpitGh, fetchPlan },
    );

    expect(result.exitCode).toBe(0);
    expect(cockpitGh.addLabel).toHaveBeenCalled();
  });

  it('missing plan.md is silently skipped (no warnings, no error)', async () => {
    const body = epicBody([{ heading: 'implement', refs: ['owner/repo#3'] }]);
    const gh = ghWithBody(body);
    const cockpitGh = stubGhWrapper();
    // planMap is empty — fetchPlan will return null for #3
    const fetchPlan = makePlanFetcher({});
    const out: string[] = [];

    const result = await runQueue(
      'owner/epic#42',
      'implement',
      { yes: true },
      { gh, cockpitGh, fetchPlan, stdout: (l) => out.push(l) },
    );

    const row3 = result.rows.find((r) => r.ref.number === 3);
    expect(row3?.dependencyWarnings).toBeUndefined();
    expect(out.some((l) => l.includes('[WARN:'))).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('non-implement phases skip the plan.md check entirely', async () => {
    const body = epicBody([{ heading: 'plan', refs: ['owner/repo#3'] }]);
    const gh = ghWithBody(body);
    const cockpitGh = stubGhWrapper({
      'owner/repo#2': { state: 'OPEN' },
    });
    const fetchPlan = vi.fn<PlanFetcher>(async () => 'depends on #2');

    await runQueue(
      'owner/epic#42',
      'plan',
      { yes: true },
      { gh, cockpitGh, fetchPlan },
    );

    // fetchPlan was NEVER called on a non-implement phase
    expect(fetchPlan).not.toHaveBeenCalled();
  });
});
