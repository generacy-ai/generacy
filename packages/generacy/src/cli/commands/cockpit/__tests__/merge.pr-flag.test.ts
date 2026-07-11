import { describe, expect, it, vi } from 'vitest';
import pino from 'pino';
import type {
  CheckRunSummary,
  DeleteHeadRefResult,
  GhWrapper,
  IssueStateResult,
  MergeResult,
  PullRequestDetail,
  PullRequestGraphqlDetail,
  RequiredChecksResult,
} from '@generacy-ai/cockpit';
import { parsePrFlag, runMergeWithExplicitPr } from '../merge.js';
import { CockpitExit } from '../exit.js';

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

interface FakeOverrides {
  graphql?: PullRequestGraphqlDetail;
  detail?: PullRequestDetail;
  issueState?: IssueStateResult;
  requiredChecks?: RequiredChecksResult;
  checkRuns?: CheckRunSummary[];
  mergeResult?: MergeResult;
  deleteHeadRef?: DeleteHeadRefResult;
}

function fakeGh(overrides: FakeOverrides): {
  gh: GhWrapper;
  calls: { mergePullRequest: number; deleteHeadRef: number };
} {
  const calls = { mergePullRequest: 0, deleteHeadRef: 0 };
  const gh: GhWrapper = {
    listIssues: vi.fn(async () => []),
    getIssue: vi.fn(async () => {
      throw new Error('getIssue not used');
    }),
    addLabels: vi.fn(async () => {}),
    removeLabels: vi.fn(async () => {}),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    getPullRequestCheckRuns: vi.fn(async () => overrides.checkRuns ?? []),
    resolveIssueToPR: vi.fn(async () => null),
    getPullRequest: vi.fn(async () => {
      throw new Error('getPullRequest not used by --pr path');
    }),
    resolveIssueToPRRef: vi.fn(async () => {
      throw new Error(
        '--pr path must NOT call resolveIssueToPRRef',
      );
    }),
    getPullRequestDetail: vi.fn(async () => {
      if (!overrides.detail) {
        throw new Error('getPullRequestDetail not stubbed');
      }
      return overrides.detail;
    }),
    getPullRequestGraphqlDetail: vi.fn(async () => {
      if (!overrides.graphql) {
        throw new Error('getPullRequestGraphqlDetail not stubbed');
      }
      return overrides.graphql;
    }),
    mergePullRequest: vi.fn(async () => {
      calls.mergePullRequest += 1;
      return overrides.mergeResult ?? { merged: true, commitSha: 'sha' };
    }),
    deleteHeadRef: vi.fn(async () => {
      calls.deleteHeadRef += 1;
      return overrides.deleteHeadRef ?? { outcome: 'deleted' as const };
    }),
    getRequiredCheckNames: vi.fn(async () =>
      overrides.requiredChecks ?? { source: 'branch-protection', names: [] },
    ),
    fetchIssueState: vi.fn(async () =>
      overrides.issueState ?? {
        state: 'OPEN',
        stateReason: null,
        closedAt: null,
        labels: ['completed:validate'],
        assignees: [],
        title: '',
      },
    ),
    postIssueComment: vi.fn(async () => ({ url: '' })),
    addAssignees: vi.fn(async () => {}),
    fetchIssueTimeline: vi.fn(async () => []),
    fetchIssueComments: vi.fn(async () => []),
    fetchIssueLabels: vi.fn(async () => ({ labels: [] })),
    getCurrentUser: vi.fn(async () => 'test-user'),
    findOpenPrForBranch: vi.fn(async () => null),
    prDiffNames: vi.fn(async () => []),
    prDiffPatch: vi.fn(async () => ''),
  };
  return { gh, calls };
}

const goodGraphql: PullRequestGraphqlDetail = {
  state: 'OPEN',
  headRefName: 'feature/foo',
  isDraft: false,
  mergeStateStatus: 'CLEAN',
  closingIssuesReferences: [{ number: 123, nameWithOwner: 'x/y' }],
};

const goodDetail: PullRequestDetail = {
  number: 456,
  title: 'PR',
  url: 'https://github.com/x/y/pull/456',
  base: 'develop',
  head: 'feature/foo',
  headRepositoryOwner: 'x',
  body: '',
  author: { login: 'alice' },
  state: 'OPEN',
  draft: false,
  labels: [],
  diff: '',
  diffTruncated: false,
};

describe('runMergeWithExplicitPr — happy path (FR-012, SC-003, SC-004)', () => {
  it('merges when linkage OK + completed:validate present + green checks', async () => {
    const { gh, calls } = fakeGh({
      graphql: goodGraphql,
      detail: goodDetail,
      requiredChecks: { source: 'branch-protection', names: ['ci/test'] },
      checkRuns: [{ name: 'ci/test', state: 'SUCCESS' }],
    });
    const result = await runMergeWithExplicitPr({
      gh,
      issue: 123,
      repo: 'x/y',
      prNumber: 456,
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(0);
    expect(calls.mergePullRequest).toBe(1);
    expect(result.stdout).toBe('merged and branch deleted\n');
  });

  it('refuses (exit 3, message names completed:validate) when label missing', async () => {
    const { gh, calls } = fakeGh({
      graphql: goodGraphql,
      detail: goodDetail,
      issueState: {
        state: 'OPEN',
        stateReason: null,
        closedAt: null,
        labels: [], // <— missing completed:validate
        assignees: [],
        title: '',
      },
    });
    const result = await runMergeWithExplicitPr({
      gh,
      issue: 123,
      repo: 'x/y',
      prNumber: 456,
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(3);
    expect(calls.mergePullRequest).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.reason).toBe('missing-label');
    // The refusal payload identifies the missing label semantically.
    expect(payload.pr.number).toBe(456);
  });
});

describe('runMergeWithExplicitPr — FR-006a linkage refusal (FR-012a, SC-007)', () => {
  it('refuses with mismatch when closingIssuesReferences does not include <ref>', async () => {
    const { gh, calls } = fakeGh({
      graphql: {
        state: 'OPEN',
        headRefName: 'feature/foo',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        closingIssuesReferences: [
          { number: 789, nameWithOwner: 'x/y' },
        ],
      },
    });
    const result = await runMergeWithExplicitPr({
      gh,
      issue: 123,
      repo: 'x/y',
      prNumber: 456,
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(3);
    expect(calls.mergePullRequest).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.reason).toBe('pr-flag-linkage-refused');
    expect(payload.kind).toBe('mismatch');
    expect(payload.message).toContain('Development sidebar');
    expect(payload.message).toContain('x/y#123');
  });

  it('refuses with empty-refs when closingIssuesReferences is empty', async () => {
    const { gh } = fakeGh({
      graphql: {
        state: 'OPEN',
        headRefName: 'feature/foo',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        closingIssuesReferences: [],
      },
    });
    const result = await runMergeWithExplicitPr({
      gh,
      issue: 123,
      repo: 'x/y',
      prNumber: 456,
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(3);
    const payload = JSON.parse(result.stdout);
    expect(payload.reason).toBe('pr-flag-linkage-refused');
    expect(payload.kind).toBe('empty-refs');
    expect(payload.message).toContain('Development sidebar');
  });
});

describe('runMergeWithExplicitPr — FR-006b state gate (FR-012b, SC-008)', () => {
  it('exit 0 idempotent no-op when PR state is MERGED', async () => {
    const { gh, calls } = fakeGh({
      graphql: {
        state: 'MERGED',
        headRefName: 'feature/foo',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        closingIssuesReferences: [{ number: 123, nameWithOwner: 'x/y' }],
      },
    });
    const result = await runMergeWithExplicitPr({
      gh,
      issue: 123,
      repo: 'x/y',
      prNumber: 456,
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(0);
    expect(calls.mergePullRequest).toBe(0);
    expect(result.stdout).toContain('already merged');
  });

  it('exit 3 refusal when PR state is CLOSED-unmerged', async () => {
    const { gh, calls } = fakeGh({
      graphql: {
        state: 'CLOSED',
        headRefName: 'feature/foo',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        closingIssuesReferences: [{ number: 123, nameWithOwner: 'x/y' }],
      },
    });
    const result = await runMergeWithExplicitPr({
      gh,
      issue: 123,
      repo: 'x/y',
      prNumber: 456,
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(3);
    expect(calls.mergePullRequest).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.reason).toBe('pr-flag-closed-unmerged');
    expect(payload.message).toContain('closed without merge');
  });
});

describe('parsePrFlag — argument parsing (contracts/pr-flag-cli.md §2)', () => {
  it('returns the parsed integer for well-formed positive integers', () => {
    expect(parsePrFlag('42')).toBe(42);
    expect(parsePrFlag('  42  ')).toBe(42); // trim
    expect(parsePrFlag('1')).toBe(1);
    expect(parsePrFlag('999999')).toBe(999999);
  });

  it('rejects malformed inputs with CockpitExit(2, ...)', () => {
    const bad = ['abc', '0', '-3', '1.5', '', ' ', '1e6', '42abc'];
    for (const input of bad) {
      let thrown: unknown = null;
      try {
        parsePrFlag(input);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, `expected throw for input "${input}"`).toBeInstanceOf(
        CockpitExit,
      );
      expect((thrown as CockpitExit).code).toBe(2);
      expect((thrown as CockpitExit).message).toContain('positive integer');
    }
  });

  it('rejects values above Number.MAX_SAFE_INTEGER', () => {
    const bigger = (Number.MAX_SAFE_INTEGER + 1).toString();
    let thrown: unknown = null;
    try {
      parsePrFlag(bigger);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CockpitExit);
    expect((thrown as CockpitExit).code).toBe(2);
  });
});

describe('runMergeWithExplicitPr — gate order (FR-008)', () => {
  it('refuses on linkage BEFORE evaluating label or checks (linkage-mismatch dominates)', async () => {
    const { gh } = fakeGh({
      // linkage empty (fails gate 1)
      graphql: {
        state: 'OPEN',
        headRefName: 'feature/foo',
        isDraft: false,
        mergeStateStatus: 'CLEAN',
        closingIssuesReferences: [],
      },
      // AND issue missing completed:validate (would fail gate 3)
      issueState: {
        state: 'OPEN',
        stateReason: null,
        closedAt: null,
        labels: [],
        assignees: [],
        title: '',
      },
      // AND checks are red (would fail gate 4)
      requiredChecks: { source: 'branch-protection', names: ['ci/test'] },
      checkRuns: [{ name: 'ci/test', state: 'FAILURE' }],
    });
    const result = await runMergeWithExplicitPr({
      gh,
      issue: 123,
      repo: 'x/y',
      prNumber: 456,
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(3);
    const payload = JSON.parse(result.stdout);
    // First failing gate is linkage — the refusal must name it,
    // not later gates.
    expect(payload.reason).toBe('pr-flag-linkage-refused');
  });
});
