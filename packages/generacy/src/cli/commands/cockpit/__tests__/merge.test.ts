import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import pino from 'pino';
import type {
  CheckRunSummary,
  GhWrapper,
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
}

function fakeGh(overrides: FakeOverrides = {}): {
  gh: GhWrapper;
  calls: { mergePullRequest: number };
} {
  const calls = { mergePullRequest: 0 };
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
    getRequiredCheckNames: vi.fn(async () =>
      overrides.getRequiredCheckNames ?? {
        source: 'branch-protection',
        names: [],
      },
    ),
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
  body: '',
  author: { login: 'alice' },
  state: 'OPEN',
  draft: false,
  labels: ['completed:validate'],
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

describe('runMerge (SC-001/002/003)', () => {
  it('SC-001: green + completed:validate → calls mergePullRequest, exit 0, empty stdout', async () => {
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
    expect(result.stdout).toBe('');
    expect(calls.mergePullRequest).toBe(1);
  });

  it('SC-002 unresolved: resolveIssueToPR null → reason=unresolved, pr=null, no merge', async () => {
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
    expect(validate(payload)).toBe(true);
  });

  it('SC-002 unresolved: PR exists but state != OPEN → reason=unresolved with pr ref', async () => {
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
    expect(validate(payload)).toBe(true);
  });

  it('SC-002 missing-label: PR without completed:validate → reason=missing-label, no merge', async () => {
    const { gh, calls } = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: { ...greenPr, labels: ['phase:plan'] },
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
    expect(validate(payload)).toBe(true);
  });

  it('SC-002 checks-failing: failing check → reason=checks-failing, no merge', async () => {
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
      getPullRequest: { ...greenPr, labels: [] },
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
    expect(JSON.parse(result.stdout).reason).toBe('missing-label');
  });
});
