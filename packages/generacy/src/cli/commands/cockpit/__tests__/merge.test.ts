import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import pino from 'pino';
import type {
  CheckRunSummary,
  DeleteHeadRefResult,
  GhWrapper,
  IssueStateResult,
  MergeResult,
  PullRequestDetail,
  PullRequestRef,
  RequiredChecksResult,
} from '@generacy-ai/cockpit';
import { runMerge } from '../merge.js';

const schemaPath = resolve(
  __dirname,
  '../../../../../../../specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json',
);
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

interface FakeOverrides {
  resolveIssueToPR?: PullRequestRef | null;
  getPullRequest?: PullRequestDetail;
  getRequiredCheckNames?: RequiredChecksResult;
  getPullRequestCheckRuns?: CheckRunSummary[];
  mergePullRequest?: MergeResult;
  fetchIssueState?: IssueStateResult | (() => IssueStateResult);
  deleteHeadRef?: DeleteHeadRefResult;
}

const defaultIssueState: IssueStateResult = {
  state: 'OPEN',
  stateReason: null,
  closedAt: null,
  labels: ['completed:validate'],
  assignees: [],
  title: '',
};

function fakeGh(overrides: FakeOverrides = {}): {
  gh: GhWrapper;
  calls: { mergePullRequest: number; deleteHeadRef: Array<[string, string]> };
} {
  const calls = {
    mergePullRequest: 0,
    deleteHeadRef: [] as Array<[string, string]>,
  };
  const gh: GhWrapper = {
    listIssues: vi.fn(async () => []),
    addLabels: vi.fn(async () => {}),
    removeLabels: vi.fn(async () => {}),
    getPullRequestCheckRuns: vi.fn(async () => overrides.getPullRequestCheckRuns ?? []),
    resolveIssueToPR: vi.fn(async () => null),
    getPullRequest: vi.fn(async () => {
      throw new Error('getPullRequest (summary) not used by runMerge');
    }),
    resolveIssueToPRRef: vi.fn(async () =>
      overrides.resolveIssueToPR === undefined
        ? null
        : overrides.resolveIssueToPR,
    ),
    getPullRequestDetail: vi.fn(async () => {
      if (!overrides.getPullRequest) {
        throw new Error('getPullRequest not stubbed');
      }
      return overrides.getPullRequest;
    }),
    mergePullRequest: vi.fn(async () => {
      calls.mergePullRequest++;
      return overrides.mergePullRequest ?? { merged: true, commitSha: 'sha' };
    }),
    deleteHeadRef: vi.fn(async (repo: string, headRef: string) => {
      calls.deleteHeadRef.push([repo, headRef]);
      return overrides.deleteHeadRef ?? { outcome: 'deleted' as const };
    }),
    getRequiredCheckNames: vi.fn(async () =>
      overrides.getRequiredCheckNames ?? {
        source: 'branch-protection',
        names: [],
      },
    ),
    fetchIssueState: vi.fn(async () => {
      const override = overrides.fetchIssueState;
      if (override === undefined) return defaultIssueState;
      if (typeof override === 'function') return override();
      return override;
    }),
  };
  return { gh, calls };
}

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

const greenPr: PullRequestDetail = {
  number: 42,
  title: 'My PR',
  url: 'https://github.com/o/r/pull/42',
  base: 'develop',
  head: 'feature/x',
  headRepositoryOwner: 'o',
  body: '',
  author: { login: 'alice' },
  state: 'OPEN',
  draft: false,
  labels: [],
  diff: '',
  diffTruncated: false,
};

const openRef: PullRequestRef = {
  number: 42,
  url: 'https://github.com/o/r/pull/42',
  state: 'OPEN',
  draft: false,
  headRefName: 'feature/x',
};

const expectedIssueRef = { owner: 'o', repo: 'r', number: 7 };

describe('runMerge (SC-001/002/003)', () => {
  it('SC-001: green + completed:validate on ISSUE → calls mergePullRequest, exit 0, branch-deletion suffix stdout', async () => {
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      getRequiredCheckNames: { source: 'branch-protection', names: ['ci/test'] },
      getPullRequestCheckRuns: [{ name: 'ci/test', state: 'SUCCESS' }],
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('merged and branch deleted\n');
    expect(calls.mergePullRequest).toBe(1);
  });

  it('SC-002 unresolved: resolveIssueToPR null → reason=unresolved, pr=null, issue ref present, no merge', async () => {
    const { gh, calls } = fakeGh({ resolveIssueToPR: null });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(1);
    expect(calls.mergePullRequest).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      status: 'red',
      reason: 'unresolved',
      pr: null,
      failingChecks: [],
    });
    expect(payload.issue).toEqual(expectedIssueRef);
    expect(validate(payload)).toBe(true);
  });

  it('SC-002 unresolved: PR exists but state != OPEN → reason=unresolved with pr ref + issue ref', async () => {
    const { gh, calls } = fakeGh({
      resolveIssueToPR: { ...openRef, state: 'CLOSED' },
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(1);
    expect(calls.mergePullRequest).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.reason).toBe('unresolved');
    expect(payload.pr).toEqual({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
    });
    expect(payload.issue).toEqual(expectedIssueRef);
    expect(validate(payload)).toBe(true);
  });

  it('SC-002 missing-label: ISSUE without completed:validate → reason=missing-label, no merge', async () => {
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      fetchIssueState: { ...defaultIssueState, labels: [] },
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(1);
    expect(calls.mergePullRequest).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.reason).toBe('missing-label');
    expect(payload.pr).toEqual({
      number: 42,
      url: 'https://github.com/o/r/pull/42',
    });
    expect(payload.failingChecks).toEqual([]);
    expect(payload.issue).toEqual(expectedIssueRef);
    expect(validate(payload)).toBe(true);
  });

  it('SC-002 checks-failing: failing check → reason=checks-failing, no merge, issue ref present', async () => {
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      getRequiredCheckNames: { source: 'branch-protection', names: ['ci/test'] },
      getPullRequestCheckRuns: [
        { name: 'ci/test', state: 'FAILURE', url: 'https://x/1' },
      ],
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(1);
    expect(calls.mergePullRequest).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.reason).toBe('checks-failing');
    expect(payload.failingChecks).toHaveLength(1);
    expect(payload.failingChecks[0]).toMatchObject({
      name: 'ci/test',
      state: 'FAILURE',
      url: 'https://x/1',
    });
    expect(payload.issue).toEqual(expectedIssueRef);
    expect(validate(payload)).toBe(true);
  });

  it('SC-002 checks-failing: pending check → reason=checks-failing with PENDING state', async () => {
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      getRequiredCheckNames: { source: 'branch-protection', names: ['ci/test'] },
      getPullRequestCheckRuns: [{ name: 'ci/test', state: 'PENDING' }],
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(1);
    expect(calls.mergePullRequest).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.failingChecks[0]?.state).toBe('PENDING');
    expect(payload.issue).toEqual(expectedIssueRef);
    expect(validate(payload)).toBe(true);
  });

  it('SC-003 MISSING synthesis: required check absent → state=MISSING', async () => {
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      getRequiredCheckNames: { source: 'branch-protection', names: ['ci/test', 'ci/extra'] },
      getPullRequestCheckRuns: [{ name: 'ci/test', state: 'SUCCESS' }],
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(1);
    expect(calls.mergePullRequest).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.reason).toBe('checks-failing');
    expect(payload.failingChecks).toEqual([
      { name: 'ci/extra', state: 'MISSING' },
    ]);
    expect(payload.issue).toEqual(expectedIssueRef);
    expect(validate(payload)).toBe(true);
  });

  it('fallback-pr-checks mode still gates merge on failing PR checks', async () => {
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      getRequiredCheckNames: { source: 'fallback-pr-checks', names: null },
      getPullRequestCheckRuns: [{ name: 'ci/test', state: 'FAILURE' }],
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(1);
    expect(calls.mergePullRequest).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.reason).toBe('checks-failing');
  });

  it('short-circuits: missing-label is reported before checks are fetched', async () => {
    const checkRunsSpy = vi.fn();
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      fetchIssueState: { ...defaultIssueState, labels: [] },
    });
    (gh.getPullRequestCheckRuns as ReturnType<typeof vi.fn>).mockImplementation(checkRunsSpy);
    (gh.getRequiredCheckNames as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('getRequiredCheckNames must not be called on missing-label branch');
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(1);
    expect(calls.mergePullRequest).toBe(0);
    expect(checkRunsSpy).not.toHaveBeenCalled();
    expect(JSON.parse(result.stdout).reason).toBe('missing-label');
  });
});

describe('runMerge FR-007 regression tests', () => {
  it('FR-007a (SC-001 counterexample): ISSUE labeled + PR unlabeled + checks green → merges', async () => {
    // The bug this test catches: reverting the fix (checking pr.labels instead
    // of issueState.labels) makes this test fail because the PR fixture has
    // labels: [].
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: { ...greenPr, labels: [] },
      fetchIssueState: {
        ...defaultIssueState,
        labels: ['completed:validate'],
      },
      getRequiredCheckNames: { source: 'branch-protection', names: ['ci/test'] },
      getPullRequestCheckRuns: [{ name: 'ci/test', state: 'SUCCESS' }],
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('merged and branch deleted\n');
    expect(calls.mergePullRequest).toBe(1);
  });

  it('FR-007b (SC-002): ISSUE unlabeled → missing-label with issue ref in payload', async () => {
    // Deleting the `issue` field extension makes this test fail.
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: { ...greenPr, labels: ['completed:validate'] },
      fetchIssueState: { ...defaultIssueState, labels: [] },
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(1);
    expect(calls.mergePullRequest).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      status: 'red',
      reason: 'missing-label',
      pr: { number: 42, url: 'https://github.com/o/r/pull/42' },
      failingChecks: [],
    });
    expect(payload.issue).toEqual(expectedIssueRef);
    expect(validate(payload)).toBe(true);
  });

  it('FR-007c (SC-003) CLOSED-issue guard: state=CLOSED → reason=unresolved with state/stateReason on issue', async () => {
    const checkRunsSpy = vi.fn();
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      fetchIssueState: {
        state: 'CLOSED',
        stateReason: 'completed',
        closedAt: '2026-07-08T00:00:00Z',
        labels: ['completed:validate'],
        assignees: [],
        title: '',
      },
    });
    (gh.getPullRequestCheckRuns as ReturnType<typeof vi.fn>).mockImplementation(checkRunsSpy);
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(1);
    expect(calls.mergePullRequest).toBe(0);
    expect(checkRunsSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      status: 'red',
      reason: 'unresolved',
      pr: { number: 42, url: 'https://github.com/o/r/pull/42' },
      failingChecks: [],
    });
    expect(payload.issue).toEqual({
      owner: 'o',
      repo: 'r',
      number: 7,
      state: 'CLOSED',
      stateReason: 'completed',
    });
    expect(validate(payload)).toBe(true);
  });

  it('Q2→B: fetchIssueState throws → reason=unresolved, pr=null, issue ref present, error logged', async () => {
    const logger = pino({ level: 'silent' });
    const errorSpy = vi.spyOn(logger, 'error');
    const err = new Error('gh network error');
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      fetchIssueState: () => {
        throw err;
      },
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger,
    });
    expect(result.exitCode).toBe(1);
    expect(calls.mergePullRequest).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      status: 'red',
      reason: 'unresolved',
      pr: null,
      failingChecks: [],
    });
    expect(payload.issue).toEqual(expectedIssueRef);
    expect(validate(payload)).toBe(true);
    // Pino was called with the raw error so it surfaces on stderr via the serializer.
    const errorCalls = errorSpy.mock.calls;
    const failedFetchCall = errorCalls.find(
      (call) => call[1] === 'Failed to fetch issue state',
    );
    expect(failedFetchCall).toBeDefined();
    expect((failedFetchCall![0] as { err: Error }).err).toBe(err);
  });
});

describe('runMerge #857 regression: no-checks is not RED', () => {
  it('(a) CI-less unprotected repo + completed:validate → merges with FR-003 stdout note, exit 0', async () => {
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      getRequiredCheckNames: { source: 'fallback-pr-checks', names: null },
      getPullRequestCheckRuns: [],
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'no checks configured and none required — proceeding on completed:validate\nmerged and branch deleted\n',
    );
    expect(calls.mergePullRequest).toBe(1);
    expect(gh.mergePullRequest).toHaveBeenCalledWith('o/r', 42, { squash: true });
  });

  it('(b) branch-protection with required contexts + empty actual → red naming missing contexts, exit 1', async () => {
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      getRequiredCheckNames: {
        source: 'branch-protection',
        names: ['ci/test', 'ci/lint'],
      },
      getPullRequestCheckRuns: [],
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(1);
    expect(calls.mergePullRequest).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.reason).toBe('checks-failing');
    expect(payload.failingChecks.map((c: { name: string }) => c.name)).toEqual([
      'ci/test',
      'ci/lint',
    ]);
    for (const c of payload.failingChecks as Array<{ state: string }>) {
      expect(c.state).toBe('MISSING');
    }
  });

  it('(c) non-empty actual with a FAILURE state → red path unchanged, exit 1', async () => {
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      getRequiredCheckNames: { source: 'branch-protection', names: ['ci/test'] },
      getPullRequestCheckRuns: [{ name: 'ci/test', state: 'FAILURE' }],
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(1);
    expect(calls.mergePullRequest).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.reason).toBe('checks-failing');
    expect(payload.failingChecks[0]).toMatchObject({
      name: 'ci/test',
      state: 'FAILURE',
    });
  });
});

describe('runMerge #859 regression: head-branch deletion after successful squash', () => {
  it('SC-101: same-owner + classify-passing + deleted → stdout "merged and branch deleted\\n"', async () => {
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      getRequiredCheckNames: { source: 'branch-protection', names: ['ci/test'] },
      getPullRequestCheckRuns: [{ name: 'ci/test', state: 'SUCCESS' }],
      deleteHeadRef: { outcome: 'deleted' },
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('merged and branch deleted\n');
    expect(calls.deleteHeadRef).toEqual([['o/r', 'feature/x']]);
  });

  it('SC-102: same-owner + vacuous-green + already-gone → stdout composes on vacuous-green + info log', async () => {
    const logger = pino({ level: 'silent' });
    const infoSpy = vi.spyOn(logger, 'info');
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      getRequiredCheckNames: { source: 'fallback-pr-checks', names: null },
      getPullRequestCheckRuns: [],
      deleteHeadRef: { outcome: 'already-gone' },
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'no checks configured and none required — proceeding on completed:validate\nmerged (branch was already deleted)\n',
    );
    expect(calls.deleteHeadRef).toEqual([['o/r', 'feature/x']]);
    const alreadyGoneCall = infoSpy.mock.calls.find(
      (call) => call[1] === 'branch was already deleted',
    );
    expect(alreadyGoneCall).toBeDefined();
  });

  it('SC-103: cross-fork PR → skipped, stdout "cross-fork PR", deleteHeadRef NOT called, info log', async () => {
    const logger = pino({ level: 'silent' });
    const infoSpy = vi.spyOn(logger, 'info');
    const forkPr: PullRequestDetail = {
      ...greenPr,
      headRepositoryOwner: 'contributor42',
    };
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: forkPr,
      getRequiredCheckNames: { source: 'branch-protection', names: ['ci/test'] },
      getPullRequestCheckRuns: [{ name: 'ci/test', state: 'SUCCESS' }],
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('merged (branch delete skipped: cross-fork PR)\n');
    expect(calls.deleteHeadRef).toEqual([]);
    const skipCall = infoSpy.mock.calls.find(
      (call) => call[1] === 'branch deletion skipped: cross-fork PR',
    );
    expect(skipCall).toBeDefined();
  });

  it('SC-104: same-owner + delete-failed → stdout wraps stderr, warn log, exit 0', async () => {
    const logger = pino({ level: 'silent' });
    const warnSpy = vi.spyOn(logger, 'warn');
    const { gh } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: greenPr,
      getRequiredCheckNames: { source: 'branch-protection', names: ['ci/test'] },
      getPullRequestCheckRuns: [{ name: 'ci/test', state: 'SUCCESS' }],
      deleteHeadRef: {
        outcome: 'delete-failed',
        stderr: 'HTTP 403: Resource not accessible by integration',
      },
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'merged (branch delete failed: HTTP 403: Resource not accessible by integration)\n',
    );
    const warnCall = warnSpy.mock.calls.find(
      (call) => call[1] === 'branch deletion failed',
    );
    expect(warnCall).toBeDefined();
    expect(warnCall![0]).toMatchObject({
      pr: 42,
      repo: 'o/r',
      headRef: 'feature/x',
      stderr: 'HTTP 403: Resource not accessible by integration',
    });
  });

  it('SC-105: null head repo + vacuous-green + deleted → falls through pre-check, composes on vacuous-green', async () => {
    const nullHeadPr: PullRequestDetail = {
      ...greenPr,
      headRepositoryOwner: null,
    };
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: nullHeadPr,
      getRequiredCheckNames: { source: 'fallback-pr-checks', names: null },
      getPullRequestCheckRuns: [],
      deleteHeadRef: { outcome: 'deleted' },
    });
    const result = await runMerge({
      gh,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      'no checks configured and none required — proceeding on completed:validate\nmerged and branch deleted\n',
    );
    expect(calls.deleteHeadRef).toEqual([['o/r', 'feature/x']]);
  });
});

describe('SC-004 meta-guard: no PullRequestDetail fixture asserts completed:validate as merge precondition', () => {
  // If a future contributor re-encodes the tests-encode-the-bug pattern
  // (#800/#826/#836) by setting labels: ['completed:validate'] on a
  // PullRequestDetail fixture, this meta-test catches it.
  const prFixtures: Array<{ name: string; fixture: PullRequestDetail }> = [
    { name: 'greenPr', fixture: greenPr },
  ];

  it.each(prFixtures)(
    'fixture $name does not carry completed:validate on labels',
    ({ fixture }) => {
      expect(fixture.labels ?? []).not.toContain('completed:validate');
    },
  );
});
