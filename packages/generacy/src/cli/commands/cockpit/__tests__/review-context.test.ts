import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import pino from 'pino';
import type {
  CheckRunSummary,
  GhWrapper,
  PullRequestDetail,
  PullRequestRef,
} from '@generacy-ai/cockpit';
import { runReviewContext } from '../review-context.js';

const schemaPath = resolve(
  __dirname,
  '../../../../../../../specs/789-epic-generacy-ai-tetrad/contracts/review-context.schema.json',
);
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

interface FakeOverrides {
  resolveIssueToPR?: PullRequestRef | null;
  getPullRequest?: PullRequestDetail;
  getPullRequestCheckRuns?: CheckRunSummary[];
}

function fakeGh(overrides: FakeOverrides = {}): GhWrapper {
  return {
    listIssues: vi.fn(async () => []),
    addLabels: vi.fn(async () => {}),
    removeLabels: vi.fn(async () => {}),
    getPullRequestCheckRuns: vi.fn(async () => overrides.getPullRequestCheckRuns ?? []),
    resolveIssueToPR: vi.fn(async () => null),
    getPullRequest: vi.fn(async () => {
      throw new Error('getPullRequest (summary) not used by runReviewContext');
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
    mergePullRequest: vi.fn(async () => ({ merged: false })),
    getRequiredCheckNames: vi.fn(async () => ({
      source: 'branch-protection' as const,
      names: [],
    })),
  };
}

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

const samplePr: PullRequestDetail = {
  number: 42,
  title: 'My PR',
  url: 'https://github.com/o/r/pull/42',
  base: 'develop',
  head: 'feature/x',
  body: 'Body text',
  author: { login: 'alice' },
  state: 'OPEN',
  draft: false,
  labels: ['completed:validate'],
  diff: '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
  diffTruncated: false,
};

const openRef: PullRequestRef = {
  number: 42,
  url: 'https://github.com/o/r/pull/42',
  state: 'OPEN',
  draft: false,
  headRefName: 'feature/x',
};

describe('runReviewContext (SC-004 / FR-010)', () => {
  it('SC-004: PR + diff + checks present, exit 0, schema-valid stdout', async () => {
    const wrapper = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: samplePr,
      getPullRequestCheckRuns: [
        { name: 'ci/test', state: 'SUCCESS', conclusion: 'success', url: 'https://x/1' },
        { name: 'ci/lint', state: 'FAILURE' },
      ],
    });
    const result = await runReviewContext({
      gh: wrapper,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.pr).toMatchObject({
      number: 42,
      title: 'My PR',
      base: 'develop',
      head: 'feature/x',
      author: 'alice',
      state: 'OPEN',
      draft: false,
    });
    expect(payload.diff).toContain('@@ -1 +1 @@');
    expect(payload.diffTruncated).toBe(false);
    expect(payload.checks).toHaveLength(2);
    expect(validate(payload)).toBe(true);
  });

  it('exits 0 even when checks are red (review-context never blocks)', async () => {
    const wrapper = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: samplePr,
      getPullRequestCheckRuns: [{ name: 'ci/test', state: 'FAILURE' }],
    });
    const result = await runReviewContext({
      gh: wrapper,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('FR-010 unresolved: returns non-zero exit, empty stdout', async () => {
    const wrapper = fakeGh({ resolveIssueToPR: null });
    const result = await runReviewContext({
      gh: wrapper,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
  });

  it('propagates diffTruncated=true into payload', async () => {
    const wrapper = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: { ...samplePr, diff: 'x', diffTruncated: true },
      getPullRequestCheckRuns: [],
    });
    const result = await runReviewContext({
      gh: wrapper,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.diffTruncated).toBe(true);
    expect(validate(payload)).toBe(true);
  });

  it('compresses author to null when PullRequestDetail.author is null', async () => {
    const wrapper = fakeGh({
      resolveIssueToPR: openRef,
      getPullRequest: { ...samplePr, author: null },
      getPullRequestCheckRuns: [],
    });
    const result = await runReviewContext({
      gh: wrapper,
      issue: 7,
      repo: 'o/r',
      logger: silentLogger(),
    });
    const payload = JSON.parse(result.stdout);
    expect(payload.pr.author).toBeNull();
    expect(validate(payload)).toBe(true);
  });
});
