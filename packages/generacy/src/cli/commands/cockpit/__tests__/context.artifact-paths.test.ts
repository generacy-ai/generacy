import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { GhWrapper } from '@generacy-ai/cockpit';
import { runContext } from '../context.js';

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/context.artifact-paths.fixture.json'), 'utf-8'),
);
const schema = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../../../../../specs/807-epic-generacy-ai-tetrad/contracts/artifact-paths-bundle.schema.json',
    ),
    'utf-8',
  ),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function stubGh(labels: string[]): GhWrapper {
  return {
    fetchIssueLabels: vi.fn(async () => ({ labels })),
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
    fetchIssueTimeline: vi.fn(),
    fetchIssueComments: vi.fn(),
    getCurrentUser: vi.fn(),
    findOpenPrForBranch: vi.fn(),
    prDiffNames: vi.fn(),
    prDiffPatch: vi.fn(),
  } as unknown as GhWrapper;
}

function makeCwd(files: Record<string, string>, issueNumber: number): string {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-context-artifacts-'));
  const branchDir = `${issueNumber}-fixture`;
  const dir = join(root, 'specs', branchDir);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return root;
}

describe('cockpit context — artifact-paths', () => {
  for (const scenario of fixture.matrix as Array<{
    label: string;
    labels: string[];
    gate: string;
    files: Record<string, string>;
  }>) {
    it(`emits schema-conformant bundle for ${scenario.label} (${scenario.gate})`, async () => {
      const root = makeCwd(scenario.files, 807);
      try {
        const out: string[] = [];
        const bundle = await runContext(fixture.issue, {
          gh: stubGh(scenario.labels),
          cwd: root,
          getBranch: async () => 'no-branch-dir-here',
          stdout: (line) => out.push(line),
        });

        expect(out).toHaveLength(1);
        const parsed = JSON.parse(out[0]!);
        expect(parsed).toEqual(bundle);
        expect(validate(parsed)).toBe(true);
        expect(parsed.issue).toBe(fixture.issue);
        expect(parsed.gate).toBe(scenario.gate);
        // All three artifacts always emitted (Q1 → D).
        expect(Object.keys(parsed.artifacts).sort()).toEqual(['plan', 'spec', 'tasks']);

        for (const name of ['spec.md', 'plan.md', 'tasks.md']) {
          const key = name.replace('.md', '') as 'spec' | 'plan' | 'tasks';
          if (scenario.files[name] != null) {
            expect(parsed.artifacts[key].body).toBe(scenario.files[name]);
          } else {
            expect(parsed.artifacts[key]).toBeNull();
          }
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
