import { describe, it, expect, vi } from 'vitest';
import { runAdvance } from '../advance.js';
import { CockpitExit } from '../exit.js';
import type { GhWrapper } from '@generacy-ai/cockpit';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const baseLoad = vi.fn(async () => ({
  config: {},
  source: 'defaults' as const,
  warnings: [],
}));

function stubGh(overrides: Partial<GhWrapper> = {}): GhWrapper {
  return {
    fetchIssueLabels: vi.fn(async () => ({ labels: [] })),
    fetchIssueState: vi.fn(),
    postIssueComment: vi.fn(async () => ({ url: 'https://github.com/o/r/issues/1#issuecomment-1' })),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    fetchIssueTimeline: vi.fn(),
    fetchIssueComments: vi.fn(),
    getCurrentUser: vi.fn(async () => 'octocat'),
    findOpenPrForBranch: vi.fn(),
    prDiffNames: vi.fn(),
    prDiffPatch: vi.fn(),
    ...overrides,
  } as GhWrapper;
}

const fixedNow = () => new Date('2026-06-26T12:00:00.000Z');

describe('cockpit advance', () => {
  it('happy path: comment → add completed → remove waiting (in order)', async () => {
    const calls: string[] = [];
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({ labels: ['waiting-for:clarification', 'phase:clarify'] })),
      postIssueComment: vi.fn(async (_repo, _n, body) => {
        calls.push('comment');
        expect(body).toContain('<!-- generacy-cockpit:manual-advance gate=clarification');
        return { url: 'https://github.com/o/r/issues/1#issuecomment-1' };
      }),
      addLabel: vi.fn(async (_repo, _n, label) => {
        calls.push(`add:${label}`);
      }),
      removeLabel: vi.fn(async (_repo, _n, label) => {
        calls.push(`remove:${label}`);
      }),
    });
    const out: string[] = [];
    await runAdvance(
      'generacy-ai/generacy#1',
      { gate: 'clarification' },
      { loadConfig: baseLoad, gh, now: fixedNow, stdout: (l) => out.push(l) },
    );
    expect(calls).toEqual(['comment', 'add:completed:clarification', 'remove:waiting-for:clarification']);
    expect(out[0]).toContain('advanced generacy-ai/generacy#1: waiting-for:clarification → completed:clarification');
  });

  it('idempotent: already-advanced is a no-op with exit 0', async () => {
    const calls: string[] = [];
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({ labels: ['completed:clarification'] })),
      postIssueComment: vi.fn(async () => {
        calls.push('comment');
        return { url: '' };
      }),
      addLabel: vi.fn(async () => {
        calls.push('add');
      }),
      removeLabel: vi.fn(async () => {
        calls.push('remove');
      }),
    });
    const out: string[] = [];
    await runAdvance(
      'generacy-ai/generacy#1',
      { gate: 'clarification' },
      { loadConfig: baseLoad, gh, now: fixedNow, stdout: (l) => out.push(l) },
    );
    expect(calls).toEqual([]);
    expect(out[0]).toContain('already advanced');
  });

  it('refusal: wrong active gate → exit 3, no side effects', async () => {
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({ labels: ['waiting-for:plan-review'] })),
    });
    const out: string[] = [];
    await expect(
      runAdvance(
        'generacy-ai/generacy#1',
        { gate: 'clarification' },
        { loadConfig: baseLoad, gh, now: fixedNow, stdout: (l) => out.push(l) },
      ),
    ).rejects.toMatchObject({ name: 'CockpitExit', code: 3 });
    expect(out[0]).toContain('refusing to advance gate "clarification"');
    expect(gh.postIssueComment).not.toHaveBeenCalled();
    expect(gh.addLabel).not.toHaveBeenCalled();
    expect(gh.removeLabel).not.toHaveBeenCalled();
  });

  it('refusal: no active waiting gate → exit 3', async () => {
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({ labels: ['phase:plan'] })),
    });
    await expect(
      runAdvance('generacy-ai/generacy#1', { gate: 'clarification' }, { loadConfig: baseLoad, gh, now: fixedNow }),
    ).rejects.toMatchObject({ name: 'CockpitExit', code: 3 });
  });

  it('unknown gate → exit 2 with valid gate list', async () => {
    await expect(
      runAdvance('generacy-ai/generacy#1', { gate: 'clarificaton' }, { loadConfig: baseLoad, gh: stubGh(), now: fixedNow }),
    ).rejects.toThrow(/unknown gate "clarificaton"/);
  });

  it('missing --gate → exit 2', async () => {
    await expect(
      runAdvance('generacy-ai/generacy#1', {}, { loadConfig: baseLoad, gh: stubGh(), now: fixedNow }),
    ).rejects.toMatchObject({ code: 2 });
  });

  it('--help-gates lists derived gates and returns 0', async () => {
    const out: string[] = [];
    await runAdvance(undefined, { helpGates: true }, {
      loadConfig: baseLoad,
      gh: stubGh(),
      now: fixedNow,
      stdout: (l) => out.push(l),
    });
    expect(out).toContain('clarification');
    expect(out).toContain('plan-review');
  });

  it('SC-005: source file does not hard-code a "completed:" string list', () => {
    const src = readFileSync(
      resolve(__dirname, '../advance.ts'),
      'utf-8',
    );
    // Allowed mentions: type imports, docstrings, error-message interpolation.
    // What must NOT exist: an array/list literal of "completed:foo" strings.
    const completedLiterals = src.match(/'completed:[a-z-]+'/g);
    expect(completedLiterals, `unexpected hard-coded completed:* literals in advance.ts: ${completedLiterals?.join(',')}`).toBeNull();
  });
});

describe('cockpit advance — CockpitExit subclass plumbing', () => {
  it('CockpitExit thrown with code', async () => {
    try {
      await runAdvance('generacy-ai/generacy#1', { gate: 'no-such' }, { loadConfig: baseLoad, gh: stubGh() });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CockpitExit);
    }
  });
});
