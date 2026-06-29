import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQueue } from '../queue.js';
import { CockpitExit } from '../exit.js';
import type { CockpitGh, IssueStateResult } from '../gh-ext.js';

const baseLoad = vi.fn(async () => ({
  config: { repos: ['generacy-ai/generacy'], orchestrator: {} },
  source: 'defaults' as const,
  warnings: [],
}));

interface IssueSeed {
  state?: 'OPEN' | 'CLOSED';
  labels?: string[];
  assignees?: string[];
  title?: string;
  notFound?: boolean;
}

function stubGh(
  states: Record<string, IssueSeed> = {},
  overrides: Partial<CockpitGh> = {},
): CockpitGh {
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
  } as CockpitGh;
}

let manifestRoot: string;
const tmpRoots: string[] = [];

function writeManifestDir(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'queue-test-'));
  tmpRoots.push(dir);
  writeFileSync(join(dir, 'epic.yaml'), yaml, 'utf-8');
  return dir;
}

beforeEach(() => {
  manifestRoot = '';
});

afterEach(() => {
  for (const r of tmpRoots) rmSync(r, { recursive: true, force: true });
  tmpRoots.length = 0;
});

const singleRepoManifest = `epic:
  repo: generacy-ai/generacy
  issue: 786
  slug: epic-cockpit
  plan: docs/epic-cockpit-plan.md
autonomy: {}
phases:
  - name: foundation
    tier: P0
    repos:
      - generacy-ai/generacy
    issues:
      - generacy-ai/generacy#101
      - generacy-ai/generacy#102
  - name: queueing
    tier: P3
    repos:
      - generacy-ai/generacy
    issues:
      - generacy-ai/generacy#791
      - generacy-ai/generacy#792
      - generacy-ai/generacy#793
`;

const multiRepoManifest = `epic:
  repo: generacy-ai/generacy
  issue: 786
  slug: epic-multi
  plan: docs/plan.md
autonomy: {}
phases:
  - name: split
    tier: P2
    repos:
      - generacy-ai/generacy
      - generacy-ai/agency
    issues:
      - generacy-ai/generacy#400
      - generacy-ai/agency#42
`;

describe('cockpit queue — phase resolution', () => {
  it('T031: resolves by tier (P3)', async () => {
    manifestRoot = writeManifestDir(singleRepoManifest);
    const gh = stubGh({
      'generacy-ai/generacy#791': {},
      'generacy-ai/generacy#792': {},
      'generacy-ai/generacy#793': {},
    });
    const out: string[] = [];
    const result = await runQueue('P3', { yes: true }, {
      loadConfig: baseLoad,
      gh,
      stdout: (l) => out.push(l),
      manifestRoot,
    });
    expect(result.resolvedPhase.name).toBe('queueing');
    expect(result.resolvedPhase.tier).toBe('P3');
    expect(result.exitCode).toBe(0);
  });

  it('T031: resolves by name (foundation)', async () => {
    manifestRoot = writeManifestDir(singleRepoManifest);
    const gh = stubGh({
      'generacy-ai/generacy#101': {},
      'generacy-ai/generacy#102': {},
    });
    const result = await runQueue('foundation', { yes: true }, {
      loadConfig: baseLoad,
      gh,
      stdout: () => {},
      manifestRoot,
    });
    expect(result.resolvedPhase.name).toBe('foundation');
    expect(result.resolvedPhase.tier).toBe('P0');
  });

  it('T032: unknown phase → exit 2 with hint', async () => {
    manifestRoot = writeManifestDir(singleRepoManifest);
    const stderr: string[] = [];
    try {
      await runQueue('P99', { yes: true }, {
        loadConfig: baseLoad,
        gh: stubGh(),
        stdout: () => {},
        stderr: (l) => stderr.push(l),
        manifestRoot,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CockpitExit);
      expect((err as CockpitExit).code).toBe(2);
      expect((err as CockpitExit).message).toContain('phase "P99" not found');
      expect((err as CockpitExit).message).toContain("Run 'generacy cockpit manifest init' first.");
    }
  });
});

describe('cockpit queue — multi-repo guard', () => {
  it('T033: multi-repo phase without --repo → exit 2 with repo list', async () => {
    manifestRoot = writeManifestDir(multiRepoManifest);
    try {
      await runQueue('P2', { yes: true }, {
        loadConfig: baseLoad,
        gh: stubGh(),
        stdout: () => {},
        manifestRoot,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CockpitExit);
      expect((err as CockpitExit).code).toBe(2);
      expect((err as CockpitExit).message).toContain('spans repos');
      expect((err as CockpitExit).message).toContain('generacy-ai/agency');
      expect((err as CockpitExit).message).toContain('generacy-ai/generacy');
      expect((err as CockpitExit).message).toContain('Pass --repo');
    }
  });

  it('T033: --repo outside phase repos → exit 2', async () => {
    manifestRoot = writeManifestDir(multiRepoManifest);
    try {
      await runQueue('P2', { repo: 'generacy-ai/elsewhere', yes: true }, {
        loadConfig: baseLoad,
        gh: stubGh(),
        stdout: () => {},
        manifestRoot,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CockpitExit);
      expect((err as CockpitExit).code).toBe(2);
      expect((err as CockpitExit).message).toContain(
        'has no issues in generacy-ai/elsewhere',
      );
    }
  });

  it('multi-repo with --repo: cross-repo refs become [SKIP: cross-repo]', async () => {
    manifestRoot = writeManifestDir(multiRepoManifest);
    const gh = stubGh({
      'generacy-ai/generacy#400': {},
    });
    const out: string[] = [];
    const result = await runQueue(
      'P2',
      { repo: 'generacy-ai/generacy', yes: true },
      { loadConfig: baseLoad, gh, stdout: (l) => out.push(l), manifestRoot },
    );
    expect(result.exitCode).toBe(0);
    const otherRepoRow = result.rows.find((r) => r.ref.repo === 'generacy-ai/agency');
    expect(otherRepoRow?.eligibility).toEqual({ kind: 'skip', reason: 'cross-repo' });
    expect(gh.addAssignees).not.toHaveBeenCalledWith(
      'generacy-ai/agency',
      expect.anything(),
      expect.anything(),
    );
  });
});

describe('cockpit queue — eligibility and label derivation', () => {
  it('T034: mixed type:bug + feature issues queue with correct workflow labels', async () => {
    manifestRoot = writeManifestDir(singleRepoManifest);
    const gh = stubGh({
      'generacy-ai/generacy#791': { labels: ['type:feature'] },
      'generacy-ai/generacy#792': { labels: ['type:bug'] },
      'generacy-ai/generacy#793': { labels: [] },
    });
    const result = await runQueue('P3', { yes: true }, {
      loadConfig: baseLoad,
      gh,
      stdout: () => {},
      manifestRoot,
    });
    const featureRow = result.rows.find((r) => r.ref.number === 791);
    const bugRow = result.rows.find((r) => r.ref.number === 792);
    const noTypeRow = result.rows.find((r) => r.ref.number === 793);
    expect(featureRow?.eligibility).toEqual({
      kind: 'eligible',
      workflowLabel: 'process:speckit-feature',
    });
    expect(bugRow?.eligibility).toEqual({
      kind: 'eligible',
      workflowLabel: 'process:speckit-bugfix',
    });
    expect(noTypeRow?.eligibility).toEqual({
      kind: 'eligible',
      workflowLabel: 'process:speckit-feature',
    });
    expect(gh.addLabel).toHaveBeenCalledWith(
      'generacy-ai/generacy',
      791,
      'process:speckit-feature',
    );
    expect(gh.addLabel).toHaveBeenCalledWith(
      'generacy-ai/generacy',
      792,
      'process:speckit-bugfix',
    );
    expect(gh.addLabel).toHaveBeenCalledWith(
      'generacy-ai/generacy',
      793,
      'process:speckit-feature',
    );
  });

  it('T035: closed issue → [SKIP: closed], not mutated', async () => {
    manifestRoot = writeManifestDir(singleRepoManifest);
    const gh = stubGh({
      'generacy-ai/generacy#791': { state: 'CLOSED' },
      'generacy-ai/generacy#792': {},
      'generacy-ai/generacy#793': {},
    });
    const result = await runQueue('P3', { yes: true }, {
      loadConfig: baseLoad,
      gh,
      stdout: () => {},
      manifestRoot,
    });
    const closedRow = result.rows.find((r) => r.ref.number === 791);
    expect(closedRow?.eligibility).toEqual({ kind: 'skip', reason: 'closed' });
    expect(gh.addAssignees).not.toHaveBeenCalledWith(
      'generacy-ai/generacy',
      791,
      expect.anything(),
    );
    expect(gh.addLabel).not.toHaveBeenCalledWith(
      'generacy-ai/generacy',
      791,
      expect.anything(),
    );
  });

  it('not-found issue → [SKIP: not-found], not mutated', async () => {
    manifestRoot = writeManifestDir(singleRepoManifest);
    const gh = stubGh({
      'generacy-ai/generacy#791': { notFound: true },
      'generacy-ai/generacy#792': {},
      'generacy-ai/generacy#793': {},
    });
    const result = await runQueue('P3', { yes: true }, {
      loadConfig: baseLoad,
      gh,
      stdout: () => {},
      manifestRoot,
    });
    const missing = result.rows.find((r) => r.ref.number === 791);
    expect(missing?.eligibility).toEqual({ kind: 'skip', reason: 'not-found' });
    expect(gh.addAssignees).not.toHaveBeenCalledWith(
      'generacy-ai/generacy',
      791,
      expect.anything(),
    );
  });
});

describe('cockpit queue — confirm gate (SC-002)', () => {
  it('T036: confirm decline → zero gh write calls, exit 0', async () => {
    manifestRoot = writeManifestDir(singleRepoManifest);
    const gh = stubGh({
      'generacy-ai/generacy#791': {},
      'generacy-ai/generacy#792': {},
      'generacy-ai/generacy#793': {},
    });
    const out: string[] = [];
    const result = await runQueue(
      'P3',
      {},
      {
        loadConfig: baseLoad,
        gh,
        prompt: async () => false,
        stdout: (l) => out.push(l),
        manifestRoot,
      },
    );
    expect(result.confirmed).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(out.some((l) => l.includes('Cancelled. No mutations made.'))).toBe(true);
    expect(gh.addAssignees).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
  });

  it('T037: --yes skips prompt and mutates eligible rows', async () => {
    manifestRoot = writeManifestDir(singleRepoManifest);
    const gh = stubGh({
      'generacy-ai/generacy#791': {},
      'generacy-ai/generacy#792': {},
      'generacy-ai/generacy#793': {},
    });
    const promptStub = vi.fn(async () => {
      throw new Error('prompt must not be called when --yes is set');
    });
    const result = await runQueue(
      'P3',
      { yes: true },
      {
        loadConfig: baseLoad,
        gh,
        prompt: promptStub,
        stdout: () => {},
        manifestRoot,
      },
    );
    expect(result.confirmed).toBe(true);
    expect(promptStub).not.toHaveBeenCalled();
    expect((gh.addAssignees as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    expect((gh.addLabel as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it('no eligible rows → prints "nothing to do", zero writes, no prompt', async () => {
    manifestRoot = writeManifestDir(singleRepoManifest);
    const gh = stubGh({
      'generacy-ai/generacy#791': { state: 'CLOSED' },
      'generacy-ai/generacy#792': { state: 'CLOSED' },
      'generacy-ai/generacy#793': { state: 'CLOSED' },
    });
    const promptStub = vi.fn(async () => true);
    const out: string[] = [];
    const result = await runQueue(
      'P3',
      {},
      {
        loadConfig: baseLoad,
        gh,
        prompt: promptStub,
        stdout: (l) => out.push(l),
        manifestRoot,
      },
    );
    expect(promptStub).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
    expect(out.some((l) => l.includes('no eligible issues — nothing to do.'))).toBe(true);
    expect(gh.addAssignees).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
  });
});

describe('cockpit queue — idempotency (SC-003)', () => {
  it('T038: rerun on already-queued phase → all already, exit 0, zero writes', async () => {
    manifestRoot = writeManifestDir(singleRepoManifest);
    const gh = stubGh({
      'generacy-ai/generacy#791': {
        labels: ['process:speckit-feature', 'type:feature'],
        assignees: ['octocat'],
      },
      'generacy-ai/generacy#792': {
        labels: ['process:speckit-feature'],
        assignees: ['octocat'],
      },
      'generacy-ai/generacy#793': {
        labels: ['process:speckit-bugfix', 'type:bug'],
        assignees: ['octocat'],
      },
    });
    const result = await runQueue('P3', { yes: true }, {
      loadConfig: baseLoad,
      gh,
      stdout: () => {},
      manifestRoot,
    });
    for (const row of result.rows.filter((r) => r.eligibility.kind === 'eligible')) {
      expect(row.assignResult).toEqual({ kind: 'already' });
      expect(row.labelResult).toEqual({ kind: 'already' });
    }
    expect(result.exitCode).toBe(0);
    expect(gh.addAssignees).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
  });
});

describe('cockpit queue — partial-failure (Q4 / FR-006)', () => {
  it('T039: addLabel fails on one issue, others succeed → exit 1, FAILED in summary', async () => {
    manifestRoot = writeManifestDir(singleRepoManifest);
    const gh = stubGh(
      {
        'generacy-ai/generacy#791': {},
        'generacy-ai/generacy#792': {},
        'generacy-ai/generacy#793': {},
      },
      {
        addLabel: vi.fn(async (_repo, n) => {
          if (n === 792) throw new Error('label not found');
        }),
      },
    );
    const out: string[] = [];
    const result = await runQueue('P3', { yes: true }, {
      loadConfig: baseLoad,
      gh,
      stdout: (l) => out.push(l),
      manifestRoot,
    });
    expect(result.exitCode).toBe(1);
    const failingRow = result.rows.find((r) => r.ref.number === 792);
    expect(failingRow?.labelResult?.kind).toBe('error');
    expect((gh.addAssignees as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
    expect(out.some((l) => l.startsWith('FAILED ') && l.includes('#792'))).toBe(true);
    expect(out.some((l) => l.startsWith('Queued ') && l.includes('#791'))).toBe(true);
    expect(out.some((l) => l.startsWith('Queued ') && l.includes('#793'))).toBe(true);
  });
});

describe('cockpit queue — assignee override', () => {
  it('T040: --assignee custom-bot overrides default, getCurrentUser not called', async () => {
    manifestRoot = writeManifestDir(singleRepoManifest);
    const getCurrentUser = vi.fn(async () => {
      throw new Error('getCurrentUser must not be called when --assignee is set');
    });
    const gh = stubGh(
      {
        'generacy-ai/generacy#791': {},
        'generacy-ai/generacy#792': {},
        'generacy-ai/generacy#793': {},
      },
      { getCurrentUser },
    );
    const result = await runQueue(
      'P3',
      { yes: true, assignee: 'custom-bot' },
      { loadConfig: baseLoad, gh, stdout: () => {}, manifestRoot },
    );
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(result.assignee).toBe('custom-bot');
    for (const call of (gh.addAssignees as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[2]).toEqual(['custom-bot']);
    }
  });

  it('invalid --assignee shape → exit 2', async () => {
    manifestRoot = writeManifestDir(singleRepoManifest);
    try {
      await runQueue('P3', { assignee: 'bad login!', yes: true }, {
        loadConfig: baseLoad,
        gh: stubGh(),
        stdout: () => {},
        manifestRoot,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CockpitExit);
      expect((err as CockpitExit).code).toBe(2);
      expect((err as CockpitExit).message).toContain('invalid --assignee');
    }
  });

  it('invalid --repo shape → exit 2', async () => {
    manifestRoot = writeManifestDir(singleRepoManifest);
    try {
      await runQueue('P3', { repo: 'not-a-repo', yes: true }, {
        loadConfig: baseLoad,
        gh: stubGh(),
        stdout: () => {},
        manifestRoot,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CockpitExit);
      expect((err as CockpitExit).code).toBe(2);
      expect((err as CockpitExit).message).toContain('invalid --repo');
    }
  });
});

describe('cockpit queue — missing manifest', () => {
  it('no manifest dir → exit 2 with init hint', async () => {
    try {
      await runQueue('P3', { yes: true }, {
        loadConfig: baseLoad,
        gh: stubGh(),
        stdout: () => {},
        manifestRoot: join(tmpdir(), 'queue-no-such-dir-' + Date.now()),
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CockpitExit);
      expect((err as CockpitExit).code).toBe(2);
      expect((err as CockpitExit).message).toContain(
        "Run 'generacy cockpit manifest init' first.",
      );
    }
  });

  it('missing <phase> arg → exit 2', async () => {
    try {
      await runQueue(undefined, { yes: true }, {
        loadConfig: baseLoad,
        gh: stubGh(),
        stdout: () => {},
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CockpitExit);
      expect((err as CockpitExit).code).toBe(2);
      expect((err as CockpitExit).message).toContain('missing required argument <phase>');
    }
  });
});
