import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { GhWrapper } from '@generacy-ai/cockpit';
import { runContext } from '../context.js';

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/context.clarification.fixture.json'), 'utf-8'),
);
const schema = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../../../../../specs/807-epic-generacy-ai-tetrad/contracts/clarification-bundle.schema.json',
    ),
    'utf-8',
  ),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function stubGh(): GhWrapper {
  return {
    fetchIssueLabels: vi.fn(async () => ({ labels: fixture.labels })),
    fetchIssueTimeline: vi.fn(async () => fixture.timeline),
    fetchIssueComments: vi.fn(async () => fixture.comments),
    findOpenPrForBranch: vi.fn(async () => fixture.prForBranch),
    prDiffNames: vi.fn(async () => fixture.prDiffNames),
    prDiffPatch: vi.fn(async () => fixture.prDiffPatch),
    // unused
    listIssues: vi.fn(),
    getIssue: vi.fn(),
    addLabels: vi.fn(),
    removeLabels: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    getPullRequestCheckRuns: vi.fn(),
    resolveIssueToPR: vi.fn(),
    getPullRequest: vi.fn(),
    resolveIssueToPRRef: vi.fn(),
    getPullRequestDetail: vi.fn(),
    mergePullRequest: vi.fn(),
    getRequiredCheckNames: vi.fn(),
    fetchIssueState: vi.fn(),
    postIssueComment: vi.fn(),
    addAssignees: vi.fn(),
    getCurrentUser: vi.fn(),
  } as unknown as GhWrapper;
}

function makeCwd(): string {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-context-clarify-'));
  const dir = join(root, 'specs', fixture.branch);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.md'), fixture.specBody);
  writeFileSync(join(dir, 'plan.md'), fixture.planBody);
  return root;
}

describe('cockpit context — clarification', () => {
  it('emits a schema-conformant clarification bundle', async () => {
    const root = makeCwd();
    try {
      const out: string[] = [];
      const bundle = await runContext(fixture.issue, {
        gh: stubGh(),
        cwd: root,
        getBranch: async () => fixture.branch,
        baseBranch: fixture.baseBranch,
        stdout: (line) => out.push(line),
      });

      expect(out).toHaveLength(1);
      const parsed = JSON.parse(out[0]!);
      expect(parsed).toEqual(bundle);
      expect(validate(parsed)).toBe(true);
      expect(parsed.issue).toBe(fixture.issue);
      expect(parsed.gate).toBe('waiting-for:clarification');
      expect(parsed.clarificationComment.url).toBe(fixture.comments[0].url);
      expect(parsed.spec.body).toBe(fixture.specBody);
      expect(parsed.plan.body).toBe(fixture.planBody);
      expect(parsed.codeReferences.prUrl).toBe(fixture.prForBranch.url);
      expect(parsed.codeReferences.touchedFiles).toEqual(fixture.prDiffNames);
      expect(parsed.codeReferences.diffPatch).toBe(fixture.prDiffPatch);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
