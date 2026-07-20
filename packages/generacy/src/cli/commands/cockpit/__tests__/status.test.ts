import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runStatus } from '../status.js';
import { FakeGh, makeIssue, makePr } from './helpers/fake-gh.js';
import type { CommandRunner, Issue } from '@generacy-ai/cockpit';

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPPOLL_BODY = readFileSync(
  join(
    HERE,
    '..',
    '..',
    '..',
    '..',
    '..',
    '..',
    'cockpit',
    'src',
    'resolver',
    '__tests__',
    'fixtures',
    'epic-1006-snappoll.md',
  ),
  'utf-8',
);

function epicBody(refs: string[]): string {
  return ['### S2 — cohort', ...refs.map((r) => `- [ ] ${r}`)].join('\n');
}

describe('runStatus', () => {
  it('emits a phase-grouped table for a multi-repo epic body (SC-002 regression)', async () => {
    const body = epicBody(['owner/repo-a#1', 'owner/repo-b#2']);
    const gh = new FakeGh({
      bodyByIssue: { 'owner/epic#42': body },
      issuesByQuery: (query: string): Issue[] => {
        if (query.startsWith('repo:owner/repo-a')) {
          return [makeIssue({ number: 1, url: 'https://github.com/owner/repo-a/issues/1' })];
        }
        if (query.startsWith('repo:owner/repo-b')) {
          return [makeIssue({ number: 2, url: 'https://github.com/owner/repo-b/issues/2' })];
        }
        return [];
      },
    });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runStatus(
      'owner/epic#42',
      {},
      { gh, stdout: (l) => out.push(l), stderr: (l) => err.push(l), logger: { warn: () => {} } },
    );
    expect(code).toBe(0);
    const joined = out.join('\n');
    expect(joined).toContain('— S2 — cohort —');
    expect(joined).not.toContain('epic owner/epic');
    expect(joined).toContain('owner/repo-a');
    expect(joined).toContain('owner/repo-b');
  });

  it('--json emits a single-line JSON envelope', async () => {
    const body = epicBody(['owner/repo#1']);
    const gh = new FakeGh({
      bodyByIssue: { 'owner/epic#42': body },
      issuesByQuery: (): Issue[] => [
        makeIssue({ number: 1, url: 'https://github.com/owner/repo/issues/1' }),
      ],
    });
    const out: string[] = [];
    const code = await runStatus(
      'owner/epic#42',
      { json: true },
      { gh, stdout: (l) => out.push(l), logger: { warn: () => {} } },
    );
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.scope.kind).toBe('epic');
    expect(parsed.scope.owner).toBe('owner');
    expect(parsed.scope.repo).toBe('epic');
    expect(parsed.scope.issue).toBe(42);
    expect(Array.isArray(parsed.rows)).toBe(true);
    expect(parsed.rows[0].repo).toBe('owner/repo');
    for (const r of parsed.rows) {
      expect(Object.prototype.hasOwnProperty.call(r, 'phase')).toBe(true);
    }
    expect(parsed.rows[0].phase).toBe('s2');
  });

  it('unparseable body exits 1 with expected-format message (SC-003)', async () => {
    const gh = new FakeGh({
      bodyByIssue: { 'owner/epic#42': 'nothing here' },
    });
    const err: string[] = [];
    const code = await runStatus(
      'owner/epic#42',
      {},
      { gh, stderr: (l) => err.push(l), logger: { warn: () => {} } },
    );
    expect(code).toBe(1);
    const joined = err.join('\n');
    expect(joined).toContain("'### <phase>'");
    expect(joined).toContain('- [ ] owner/repo#N');
  });

  it('malformed <epic-ref> exits 2 with parse issue error message (FR-007)', async () => {
    const gh = new FakeGh({});
    const err: string[] = [];
    const code = await runStatus(
      'garbage',
      {},
      { gh, stderr: (l) => err.push(l), logger: { warn: () => {} } },
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toBe(
      'cockpit status: parse issue: unrecognized issue ref "garbage". ' +
        'Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.',
    );
  });

  it('missing <epic-ref> exits 2', async () => {
    const gh = new FakeGh({});
    const err: string[] = [];
    const code = await runStatus(undefined, {}, { gh, stderr: (l) => err.push(l) });
    expect(code).toBe(2);
    expect(err.join('\n')).toContain('parse issue: issue argument is required');
  });

  it('#857: wrapper resolves [] → row.checks === "none"', async () => {
    const body = epicBody(['owner/repo#5']);
    const gh = new FakeGh({
      bodyByIssue: { 'owner/epic#42': body },
      issuesByQuery: (): Issue[] => [
        makePr({ number: 5, url: 'https://github.com/owner/repo/pull/5' }),
      ],
      // checksByPr unset → getPullRequestCheckRuns resolves [] by default.
    });
    const out: string[] = [];
    const code = await runStatus(
      'owner/epic#42',
      { json: true },
      { gh, stdout: (l) => out.push(l), logger: { warn: () => {} } },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out[0]!);
    const row = parsed.rows.find((r: { number: number }) => r.number === 5);
    expect(row?.checks).toBe('none');
  });

  it('#857: real wrapper throw → row.checks === "error" (distinct from "none")', async () => {
    const body = epicBody(['owner/repo#6']);
    const gh = new FakeGh({
      bodyByIssue: { 'owner/epic#42': body },
      issuesByQuery: (): Issue[] => [
        makePr({ number: 6, url: 'https://github.com/owner/repo/pull/6' }),
      ],
    });
    // Force getPullRequestCheckRuns to throw a real error (not a no-checks case).
    gh.getPullRequestCheckRuns = async () => {
      throw new Error('gh pr checks failed (exit 1): HTTP 500 boom');
    };
    const out: string[] = [];
    const code = await runStatus(
      'owner/epic#42',
      { json: true },
      { gh, stdout: (l) => out.push(l), logger: { warn: () => {} } },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(out[0]!);
    const row = parsed.rows.find((r: { number: number }) => r.number === 6);
    expect(row?.checks).toBe('error');
    expect(row?.checks).not.toBe('none');
  });

  it('bare number resolves via injected runner (US2)', async () => {
    const body = epicBody(['owner/repo#5']);
    const gh = new FakeGh({
      bodyByIssue: { 'owner/repo#1': body },
      issuesByQuery: (): Issue[] => [
        makeIssue({ number: 5, url: 'https://github.com/owner/repo/issues/5' }),
      ],
    });
    const runner: CommandRunner = vi.fn(async () => ({
      stdout: 'https://github.com/owner/repo.git\n',
      stderr: '',
      exitCode: 0,
    }));
    const out: string[] = [];
    const code = await runStatus(
      '1',
      {},
      { gh, runner, stdout: (l) => out.push(l), logger: { warn: () => {} } },
    );
    expect(code).toBe(0);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(out.join('\n')).toContain('— S2 — cohort —');
  });

  // #935 SC-003: flat-list scope bodies render as a single Ad-hoc group with
  // scope header `(flat, N refs)`.
  it('flat body renders single Ad-hoc group with `(flat, N refs)` header (#935 SC-003)', async () => {
    const body = ['- [ ] owner/repo#1', '- [ ] owner/repo#2'].join('\n');
    const gh = new FakeGh({
      bodyByIssue: { 'owner/scope#42': body },
      issuesByQuery: (): Issue[] => [
        makeIssue({ number: 1, url: 'https://github.com/owner/repo/issues/1' }),
        makeIssue({ number: 2, url: 'https://github.com/owner/repo/issues/2' }),
      ],
    });
    const out: string[] = [];
    const code = await runStatus(
      'owner/scope#42',
      {},
      { gh, stdout: (l) => out.push(l), logger: { warn: () => {} } },
    );
    expect(code).toBe(0);
    const joined = out.join('\n');
    expect(joined).toContain('Scope: owner/scope#42');
    expect(joined).toContain('(flat, 2 refs)');
    expect(joined).toContain('— Ad-hoc —');
    expect(joined).not.toContain('— (no phase) —');
  });

  it('phased body with `## Ad-hoc` section renders both phase groups and Ad-hoc group (#935)', async () => {
    const body = [
      '### S1 alpha',
      '- [ ] owner/repo#1',
      '## Ad-hoc',
      '- [ ] owner/repo#9',
    ].join('\n');
    const gh = new FakeGh({
      bodyByIssue: { 'owner/epic#42': body },
      issuesByQuery: (): Issue[] => [
        makeIssue({ number: 1, url: 'https://github.com/owner/repo/issues/1' }),
        makeIssue({ number: 9, url: 'https://github.com/owner/repo/issues/9' }),
      ],
    });
    const out: string[] = [];
    const code = await runStatus(
      'owner/epic#42',
      {},
      { gh, stdout: (l) => out.push(l), logger: { warn: () => {} } },
    );
    expect(code).toBe(0);
    const joined = out.join('\n');
    expect(joined).toContain('(phased, 2 refs)');
    expect(joined).toContain('— S1 alpha —');
    expect(joined).toContain('— Ad-hoc —');
  });

  it('phased body with empty adhocRefs does NOT emit an Ad-hoc group (#935)', async () => {
    const body = ['### S1 alpha', '- [ ] owner/repo#1'].join('\n');
    const gh = new FakeGh({
      bodyByIssue: { 'owner/epic#42': body },
      issuesByQuery: (): Issue[] => [
        makeIssue({ number: 1, url: 'https://github.com/owner/repo/issues/1' }),
      ],
    });
    const out: string[] = [];
    const code = await runStatus(
      'owner/epic#42',
      {},
      { gh, stdout: (l) => out.push(l), logger: { warn: () => {} } },
    );
    expect(code).toBe(0);
    const joined = out.join('\n');
    expect(joined).toContain('(phased, 1 refs)');
    expect(joined).toContain('— S1 alpha —');
    expect(joined).not.toContain('— Ad-hoc —');
  });

  // #1006 (FR-012): --json envelope always carries a `warnings: string[]`
  // field — empty on clean bodies, populated on the H4-phase-header defect.
  describe('--json envelope carries parsed.warnings (#1006 FR-012)', () => {
    it('emits `warnings: []` (present, empty) on a clean epic body', async () => {
      const body = epicBody(['owner/repo#1']);
      const gh = new FakeGh({
        bodyByIssue: { 'owner/epic#42': body },
        issuesByQuery: (): Issue[] => [
          makeIssue({ number: 1, url: 'https://github.com/owner/repo/issues/1' }),
        ],
      });
      const out: string[] = [];
      const code = await runStatus(
        'owner/epic#42',
        { json: true },
        { gh, stdout: (l) => out.push(l), logger: { warn: () => {} } },
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(out[0]!);
      expect(Array.isArray(parsed.warnings)).toBe(true);
      expect(parsed.warnings).toEqual([]);
    });

    it('emits H4-phase-header marker on the snappoll fixture body', async () => {
      const gh = new FakeGh({
        bodyByIssue: { 'christrudelpw/snappoll#1': SNAPPOLL_BODY },
        // All 12 refs fall to ad-hoc, so issuesByQuery is exercised per repo
        // batch — but the resolver's warning fires regardless of GH results.
        issuesByQuery: (): Issue[] => [],
      });
      const out: string[] = [];
      const code = await runStatus(
        'christrudelpw/snappoll#1',
        { json: true },
        { gh, stdout: (l) => out.push(l), logger: { warn: () => {} } },
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(out[0]!);
      expect(Array.isArray(parsed.warnings)).toBe(true);
      expect(parsed.warnings.length).toBeGreaterThanOrEqual(1);
      expect(
        parsed.warnings.some((w: string) => w.includes("phase headers must be '###'")),
      ).toBe(true);
    });
  });
});
