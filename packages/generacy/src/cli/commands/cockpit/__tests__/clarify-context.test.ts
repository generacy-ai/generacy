import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runClarifyContext } from '../clarify-context.js';
import { CockpitExit } from '../exit.js';
import type { CockpitGh } from '../gh-ext.js';

const baseLoad = vi.fn(async () => ({
  config: { repos: ['generacy-ai/generacy'], orchestrator: {} },
  source: 'defaults' as const,
  warnings: [],
}));

function stubGh(overrides: Partial<CockpitGh> = {}): CockpitGh {
  return {
    fetchIssueLabels: vi.fn(async () => ({ labels: ['waiting-for:clarification'] })),
    fetchIssueState: vi.fn(),
    postIssueComment: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    fetchIssueTimeline: vi.fn(async () => [
      {
        event: 'labeled',
        label: { name: 'waiting-for:clarification' },
        created_at: '2026-06-25T10:00:00Z',
      },
    ]),
    fetchIssueComments: vi.fn(async () => [
      { body: 'q1', author: 'bot', createdAt: '2026-06-25T11:00:00Z', url: 'u' },
    ]),
    getCurrentUser: vi.fn(),
    findOpenPrForBranch: vi.fn(async () => ({ url: 'https://github.com/o/r/pull/9', number: 9 })),
    prDiffNames: vi.fn(async () => ['a.ts']),
    prDiffPatch: vi.fn(async () => 'diff'),
    ...overrides,
  } as CockpitGh;
}

function makeCwdWithSpec(branch: string): string {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-test-'));
  const dir = join(root, 'specs', branch);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.md'), '# spec body');
  writeFileSync(join(dir, 'plan.md'), '# plan body');
  return root;
}

describe('cockpit clarify-context', () => {
  it('happy path: all four fields populated, valid JSON on stdout', async () => {
    const root = makeCwdWithSpec('788-epic-generacy-ai-tetrad');
    try {
      const out: string[] = [];
      const result = await runClarifyContext('123', {
        loadConfig: baseLoad,
        gh: stubGh(),
        cwd: root,
        getBranch: async () => '788-epic-generacy-ai-tetrad',
        baseBranch: 'develop',
        stdout: (l) => out.push(l),
      });
      // Stdout must contain exactly one valid JSON document.
      expect(out.length).toBe(1);
      const parsed = JSON.parse(out[0]!);
      expect(parsed).toEqual(result);
      expect(parsed.issue).toBe('generacy-ai/generacy#123');
      expect(parsed.clarificationComment?.url).toBe('u');
      expect(parsed.spec?.body).toBe('# spec body');
      expect(parsed.plan?.body).toBe('# plan body');
      expect(parsed.codeReferences?.prUrl).toBe('https://github.com/o/r/pull/9');
      expect(parsed.codeReferences?.touchedFiles).toEqual(['a.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses when issue is not in waiting-for:clarification (exit 3)', async () => {
    const gh = stubGh({ fetchIssueLabels: vi.fn(async () => ({ labels: ['phase:plan'] })) });
    await expect(
      runClarifyContext('1', {
        loadConfig: baseLoad,
        gh,
        cwd: '/tmp',
        getBranch: async () => 'feat',
        baseBranch: 'develop',
      }),
    ).rejects.toMatchObject({ name: 'CockpitExit', code: 3 });
  });

  it('missing spec.md → spec: null but stable schema', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-test-'));
    try {
      const out: string[] = [];
      await runClarifyContext('123', {
        loadConfig: baseLoad,
        gh: stubGh(),
        cwd: root,
        getBranch: async () => 'no-such-branch',
        baseBranch: 'develop',
        stdout: (l) => out.push(l),
      });
      const parsed = JSON.parse(out[0]!);
      expect(parsed.spec).toBeNull();
      expect(parsed.plan).toBeNull();
      // Stable schema — fields still present
      expect(Object.keys(parsed).sort()).toEqual(
        ['clarificationComment', 'codeReferences', 'issue', 'plan', 'spec'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to specs/<issueNumber>-* scan when branch dir missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-test-'));
    const dir = join(root, 'specs', '123-fallback-dir');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'spec.md'), 'fb-spec');
    try {
      const out: string[] = [];
      await runClarifyContext('123', {
        loadConfig: baseLoad,
        gh: stubGh(),
        cwd: root,
        getBranch: async () => 'unrelated-branch',
        baseBranch: 'develop',
        stdout: (l) => out.push(l),
      });
      const parsed = JSON.parse(out[0]!);
      expect(parsed.spec?.body).toBe('fb-spec');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('no PR for branch → prUrl null, prDiffSummary null, touchedFiles from git diff', async () => {
    const root = makeCwdWithSpec('feat-x');
    try {
      const gh = stubGh({ findOpenPrForBranch: vi.fn(async () => null) });
      const out: string[] = [];
      await runClarifyContext('123', {
        loadConfig: baseLoad,
        gh,
        cwd: root,
        getBranch: async () => 'feat-x',
        baseBranch: 'develop',
        runner: async () => ({ stdout: 'foo.ts\nbar.ts\n', stderr: '', exitCode: 0 }),
        stdout: (l) => out.push(l),
      });
      const parsed = JSON.parse(out[0]!);
      expect(parsed.codeReferences.prUrl).toBeNull();
      expect(parsed.codeReferences.prDiffSummary).toBeNull();
      expect(parsed.codeReferences.touchedFiles).toEqual(['foo.ts', 'bar.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('branch == base (no feature branch) → codeReferences null', async () => {
    const root = makeCwdWithSpec('develop');
    try {
      const out: string[] = [];
      await runClarifyContext('123', {
        loadConfig: baseLoad,
        gh: stubGh(),
        cwd: root,
        getBranch: async () => 'develop',
        baseBranch: 'develop',
        stdout: (l) => out.push(l),
      });
      const parsed = JSON.parse(out[0]!);
      expect(parsed.codeReferences).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stdout is a single line of valid JSON (SC-002)', async () => {
    const root = makeCwdWithSpec('788-epic-generacy-ai-tetrad');
    try {
      const captured: string[] = [];
      await runClarifyContext('123', {
        loadConfig: baseLoad,
        gh: stubGh(),
        cwd: root,
        getBranch: async () => '788-epic-generacy-ai-tetrad',
        baseBranch: 'develop',
        stdout: (l) => captured.push(l),
      });
      expect(captured).toHaveLength(1);
      expect(() => JSON.parse(captured[0]!)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cockpit clarify-context — exits', () => {
  it('CockpitExit type matches', async () => {
    const gh = stubGh({ fetchIssueLabels: vi.fn(async () => ({ labels: [] })) });
    try {
      await runClarifyContext('1', { loadConfig: baseLoad, gh, cwd: '/tmp' });
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CockpitExit);
      expect((err as CockpitExit).code).toBe(3);
    }
  });
});
