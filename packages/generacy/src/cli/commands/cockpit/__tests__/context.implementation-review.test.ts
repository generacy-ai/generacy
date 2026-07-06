import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { GhWrapper } from '@generacy-ai/cockpit';
import { CockpitExit } from '../exit.js';
import { runContext } from '../context.js';

const fixture = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures/context.implementation-review.fixture.json'),
    'utf-8',
  ),
);
const schema = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../../../../../specs/807-epic-generacy-ai-tetrad/contracts/implementation-review-bundle.schema.json',
    ),
    'utf-8',
  ),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function stubGh(overrides: Partial<GhWrapper> = {}): GhWrapper {
  const base: Partial<GhWrapper> = {
    fetchIssueLabels: vi.fn(async () => ({ labels: fixture.labels })),
    resolveIssueToPRRef: vi.fn(async () => fixture.prRef),
    getPullRequestDetail: vi.fn(async () => fixture.prDetail),
    getPullRequestCheckRuns: vi.fn(async () => fixture.checks),
    listIssues: vi.fn(),
    getIssue: vi.fn(),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    resolveIssueToPR: vi.fn(),
    getPullRequest: vi.fn(),
    mergePullRequest: vi.fn(),
    getRequiredCheckNames: vi.fn(),
    fetchIssueState: vi.fn(),
    postIssueComment: vi.fn(),
    addAssignees: vi.fn(),
    fetchIssueTimeline: vi.fn(),
    fetchIssueComments: vi.fn(),
    getCurrentUser: vi.fn(),
    findOpenPrForBranch: vi.fn(),
    prDiffNames: vi.fn(),
    prDiffPatch: vi.fn(),
  };
  return { ...base, ...overrides } as GhWrapper;
}

describe('cockpit context — implementation-review', () => {
  it('emits a schema-conformant implementation-review bundle', async () => {
    const out: string[] = [];
    const bundle = await runContext(fixture.issue, {
      gh: stubGh(),
      stdout: (line) => out.push(line),
    });

    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!);
    expect(parsed).toEqual(bundle);
    expect(validate(parsed)).toBe(true);
    expect(parsed.issue).toBe(fixture.issue);
    expect(parsed.gate).toBe('waiting-for:implementation-review');
    expect(parsed.pr.number).toBe(fixture.prRef.number);
    expect(parsed.pr.author).toBe(fixture.prDetail.author.login);
    expect(parsed.diff).toBe(fixture.prDetail.diff);
    expect(parsed.checks).toHaveLength(fixture.checks.length);
  });

  it('exits 3 when the PR-scoped gate has no linked PR', async () => {
    const gh = stubGh({ resolveIssueToPRRef: vi.fn(async () => null) });
    await expect(
      runContext(fixture.issue, { gh, stdout: () => {} }),
    ).rejects.toMatchObject({
      name: 'CockpitExit',
      code: 3,
      message: expect.stringContaining('no linked PR resolved'),
    });
  });

  it('propagates gh IO failures at exit 1', async () => {
    const gh = stubGh({
      resolveIssueToPRRef: vi.fn(async () => {
        throw new Error('gh boom');
      }),
    });
    await expect(
      runContext(fixture.issue, { gh, stdout: () => {} }),
    ).rejects.toMatchObject({ name: 'CockpitExit', code: 1 });
  });

  it('throws CockpitExit (typed exception) not a generic Error', async () => {
    const gh = stubGh({ resolveIssueToPRRef: vi.fn(async () => null) });
    try {
      await runContext(fixture.issue, { gh, stdout: () => {} });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CockpitExit);
    }
  });
});
