import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runResume } from '../resume.js';
import { CockpitExit } from '../exit.js';
import type { CommandRunner, GhWrapper } from '@generacy-ai/cockpit';

const baseLoad = vi.fn(async () => ({
  config: {},
  source: 'defaults' as const,
  warnings: [],
}));

function stubGh(overrides: Partial<GhWrapper> = {}): GhWrapper {
  return {
    fetchIssueLabels: vi.fn(async () => ({ labels: [] })),
    fetchIssueState: vi.fn(),
    postIssueComment: vi.fn(async () => ({ url: '' })),
    addLabel: vi.fn(async () => {}),
    removeLabel: vi.fn(async () => {}),
    addLabels: vi.fn(async () => {}),
    removeLabels: vi.fn(async () => {}),
    fetchIssueTimeline: vi.fn(),
    fetchIssueComments: vi.fn(),
    getCurrentUser: vi.fn(async () => 'octocat'),
    findOpenPrForBranch: vi.fn(),
    prDiffNames: vi.fn(),
    prDiffPatch: vi.fn(),
    ...overrides,
  } as GhWrapper;
}

const fixedNow = () => new Date('2026-07-09T12:00:00.000Z');

// -------------------------------------------------------------------------
// FR-008(a) — Happy paths per failed:<phase> suffix
// -------------------------------------------------------------------------
describe('cockpit resume — FR-008(a) happy path per phase', () => {
  const cases: {
    phase: string;
    precedingGate: string;
    workflow: string;
    inputLabels: string[];
    expectedRemoved: string[];
  }[] = [
    {
      phase: 'validate',
      precedingGate: 'implementation-review',
      workflow: 'speckit-feature',
      inputLabels: [
        'workflow:speckit-feature',
        'failed:validate',
        'agent:error',
        'phase:validate',
        'completed:specify',
        'completed:clarify',
        'completed:plan',
        'completed:tasks',
        'completed:implement',
      ],
      expectedRemoved: ['failed:validate', 'agent:error', 'phase:validate'],
    },
    {
      phase: 'implement',
      precedingGate: 'tasks-review',
      workflow: 'speckit-feature',
      inputLabels: [
        'workflow:speckit-feature',
        'failed:implement',
        'agent:error',
        'phase:implement',
      ],
      expectedRemoved: ['failed:implement', 'agent:error', 'phase:implement'],
    },
    {
      phase: 'tasks',
      precedingGate: 'plan-review',
      workflow: 'speckit-feature',
      inputLabels: [
        'workflow:speckit-feature',
        'failed:tasks',
        'agent:error',
        'phase:tasks',
      ],
      expectedRemoved: ['failed:tasks', 'agent:error', 'phase:tasks'],
    },
    {
      phase: 'clarify',
      precedingGate: 'spec-review',
      workflow: 'speckit-feature',
      inputLabels: [
        'workflow:speckit-feature',
        'failed:clarify',
        'agent:error',
        'phase:clarify',
      ],
      expectedRemoved: ['failed:clarify', 'agent:error', 'phase:clarify'],
    },
  ];

  for (const c of cases) {
    it(`failed:${c.phase} → ${c.precedingGate}: adds first, then removes; exit 0; log line`, async () => {
      const calls: string[] = [];
      const addLabels = vi.fn(async (_nwo: string, _n: number, labels: string[]) => {
        calls.push(`add:${labels.join(',')}`);
      });
      const removeLabels = vi.fn(async (_nwo: string, _n: number, labels: string[]) => {
        calls.push(`remove:${labels.join(',')}`);
      });
      const gh = stubGh({
        fetchIssueLabels: vi.fn(async () => ({ labels: c.inputLabels })),
        addLabels,
        removeLabels,
      });
      const out: string[] = [];
      await runResume(
        'generacy-ai/generacy#42',
        {},
        { loadConfig: baseLoad, gh, now: fixedNow, stdout: (l) => out.push(l) },
      );

      // Additions BEFORE removals (Assumption §7)
      expect(calls[0]).toBe(
        `add:waiting-for:${c.precedingGate},completed:${c.precedingGate},agent:paused`,
      );
      expect(calls[1]).toBe(`remove:${c.expectedRemoved.join(',')}`);

      // Log line
      expect(out[0]).toMatch(
        new RegExp(
          `^resumed generacy-ai/generacy#42: re-armed phase=${c.phase} via preceding-gate=${c.precedingGate}; ` +
            `added=\\[waiting-for:${c.precedingGate},completed:${c.precedingGate},agent:paused\\] ` +
            `removed=\\[${c.expectedRemoved.join(',').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]$`,
        ),
      );
    });
  }
});

// -------------------------------------------------------------------------
// FR-008(b) — No-op path on non-failed issues
// -------------------------------------------------------------------------
describe('cockpit resume — FR-008(b) no-op on non-failed issues', () => {
  it('no failed:* label → zero mutations, exit 0, single-line stdout', async () => {
    const addLabels = vi.fn(async () => {});
    const removeLabels = vi.fn(async () => {});
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({
        labels: ['workflow:speckit-feature', 'waiting-for:tasks-review', 'phase:tasks'],
      })),
      addLabels,
      removeLabels,
    });
    const out: string[] = [];
    await runResume(
      'generacy-ai/generacy#42',
      {},
      { loadConfig: baseLoad, gh, now: fixedNow, stdout: (l) => out.push(l) },
    );

    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabels).not.toHaveBeenCalled();
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(
      'issue generacy-ai/generacy#42 is not in a failed state (no failed:<phase> label); nothing to re-arm',
    );
  });
});

// -------------------------------------------------------------------------
// FR-008(c) — Four refusal branches
// -------------------------------------------------------------------------
describe('cockpit resume — FR-008(c) refusal branches (exit 3)', () => {
  it('multiple failed:* labels → refuse with evidence line, zero mutations', async () => {
    const addLabels = vi.fn(async () => {});
    const removeLabels = vi.fn(async () => {});
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({
        labels: ['workflow:speckit-feature', 'failed:validate', 'failed:tasks'],
      })),
      addLabels,
      removeLabels,
    });
    let caught: unknown = null;
    try {
      await runResume(
        'generacy-ai/generacy#42',
        {},
        { loadConfig: baseLoad, gh, now: fixedNow },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CockpitExit);
    expect((caught as CockpitExit).code).toBe(3);
    expect((caught as CockpitExit).message).toMatch(
      /^Error: cockpit resume: refusing to resume: multiple failed:\* labels present: \[.*failed:tasks.*failed:validate.*\]$/,
    );
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabels).not.toHaveBeenCalled();
  });

  it('failed:<unknown-phase> → refuse with unknown-phase evidence, zero mutations', async () => {
    const addLabels = vi.fn(async () => {});
    const removeLabels = vi.fn(async () => {});
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({
        labels: ['workflow:speckit-feature', 'failed:gibberish'],
      })),
      addLabels,
      removeLabels,
    });
    let caught: unknown = null;
    try {
      await runResume(
        'generacy-ai/generacy#42',
        {},
        { loadConfig: baseLoad, gh, now: fixedNow },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CockpitExit);
    expect((caught as CockpitExit).code).toBe(3);
    expect((caught as CockpitExit).message).toBe(
      'Error: cockpit resume: refusing to resume: unknown phase "gibberish" in label "failed:gibberish"',
    );
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabels).not.toHaveBeenCalled();
  });

  it('failed:specify → refuse with "no preceding gate" evidence pointing at process:speckit-feature', async () => {
    const addLabels = vi.fn(async () => {});
    const removeLabels = vi.fn(async () => {});
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({
        labels: ['workflow:speckit-feature', 'failed:specify'],
      })),
      addLabels,
      removeLabels,
    });
    let caught: unknown = null;
    try {
      await runResume(
        'generacy-ai/generacy#42',
        {},
        { loadConfig: baseLoad, gh, now: fixedNow },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CockpitExit);
    expect((caught as CockpitExit).code).toBe(3);
    expect((caught as CockpitExit).message).toBe(
      'Error: cockpit resume: refusing to resume: phase "specify" has no preceding gate; ' +
        'use `process:speckit-feature` label to re-queue from the beginning instead',
    );
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabels).not.toHaveBeenCalled();
  });

  it('failed:plan → refuse with "no preceding gate" evidence', async () => {
    const addLabels = vi.fn(async () => {});
    const removeLabels = vi.fn(async () => {});
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({
        labels: ['workflow:speckit-feature', 'failed:plan'],
      })),
      addLabels,
      removeLabels,
    });
    let caught: unknown = null;
    try {
      await runResume(
        'generacy-ai/generacy#42',
        {},
        { loadConfig: baseLoad, gh, now: fixedNow },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CockpitExit);
    expect((caught as CockpitExit).code).toBe(3);
    expect((caught as CockpitExit).message).toContain(
      'refusing to resume: phase "plan" has no preceding gate; use `process:speckit-feature` label to re-queue from the beginning instead',
    );
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabels).not.toHaveBeenCalled();
  });

  it('failed:validate with conflicting waiting-for:<other> → refuse with conflicting-waiting evidence', async () => {
    const addLabels = vi.fn(async () => {});
    const removeLabels = vi.fn(async () => {});
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({
        labels: [
          'workflow:speckit-feature',
          'failed:validate',
          'waiting-for:plan-review', // conflicts with derived implementation-review
        ],
      })),
      addLabels,
      removeLabels,
    });
    let caught: unknown = null;
    try {
      await runResume(
        'generacy-ai/generacy#42',
        {},
        { loadConfig: baseLoad, gh, now: fixedNow },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CockpitExit);
    expect((caught as CockpitExit).code).toBe(3);
    expect((caught as CockpitExit).message).toBe(
      'Error: cockpit resume: refusing to resume: conflicting waiting-for:plan-review already present; ' +
        'derived preceding-gate is implementation-review',
    );
    expect(addLabels).not.toHaveBeenCalled();
    expect(removeLabels).not.toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------
// FR-008(d) — Issue-ref grammar wiring (#850)
// -------------------------------------------------------------------------
describe('cockpit resume — FR-008(d) bare-number ref resolution (#850)', () => {
  it('bare-number: infers repo from git origin and calls fetchIssueLabels(owner/repo, N)', async () => {
    const fetchLabels = vi.fn(async () => ({
      labels: ['workflow:speckit-feature', 'failed:validate', 'agent:error'],
    }));
    const gh = stubGh({ fetchIssueLabels: fetchLabels });
    const runner: CommandRunner = vi.fn(async (cmd, args) => {
      expect(cmd).toBe('git');
      expect(args).toEqual(['remote', 'get-url', 'origin']);
      return { stdout: 'https://github.com/owner/repo.git\n', stderr: '', exitCode: 0 };
    });
    await runResume(
      '42',
      {},
      { loadConfig: baseLoad, gh, runner, now: fixedNow, stdout: () => {} },
    );
    expect(fetchLabels).toHaveBeenCalledWith('owner/repo', 42);
  });

  it('bare-number failure: unresolvable origin → CockpitExit(2) with FR-002 copy', async () => {
    const gh = stubGh();
    const runner: CommandRunner = vi.fn(async () => ({
      stdout: '',
      stderr: 'fatal: no such remote',
      exitCode: 128,
    }));
    let caught: unknown = null;
    try {
      await runResume(
        '42',
        {},
        { loadConfig: baseLoad, gh, runner, now: fixedNow, stdout: () => {} },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CockpitExit);
    expect((caught as CockpitExit).code).toBe(2);
    const msg = (caught as CockpitExit).message;
    expect(msg).toMatch(
      /^Error: cockpit resume: parse issue: bare issue number "42" is not accepted here\./,
    );
    expect(msg).toMatch(
      /Accepted: <owner>\/<repo>#42, a full issue URL, or a bare number inside a checkout/,
    );
  });

  it('owner/repo#N: does NOT call git remote get-url origin', async () => {
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({
        labels: ['workflow:speckit-feature', 'failed:validate'],
      })),
    });
    const runner: CommandRunner = vi.fn();
    await runResume(
      'owner/repo#42',
      {},
      { loadConfig: baseLoad, gh, runner, now: fixedNow, stdout: () => {} },
    );
    for (const call of (runner as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).not.toEqual(['remote', 'get-url', 'origin']);
    }
  });

  it('SC-007: resume.ts source does not import parseIssueRef directly', () => {
    const src = readFileSync(resolve(__dirname, '../resume.ts'), 'utf-8');
    // Allowed: comments referencing the name. Not allowed: an import statement
    // that pulls parseIssueRef into scope.
    expect(src).not.toMatch(/import\s*\{[^}]*\bparseIssueRef\b[^}]*\}\s*from/);
  });
});

// -------------------------------------------------------------------------
// FR-002 ordering + Q3/Q5 defensive + preservation invariants
// -------------------------------------------------------------------------
describe('cockpit resume — FR-002 ordering + Q3/Q5 invariants', () => {
  it('addLabels invocation index < removeLabels invocation index', async () => {
    const order: string[] = [];
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({
        labels: ['workflow:speckit-feature', 'failed:validate', 'agent:error', 'phase:validate'],
      })),
      addLabels: vi.fn(async () => {
        order.push('add');
      }),
      removeLabels: vi.fn(async () => {
        order.push('remove');
      }),
    });
    await runResume(
      'generacy-ai/generacy#42',
      {},
      { loadConfig: baseLoad, gh, now: fixedNow, stdout: () => {} },
    );
    expect(order).toEqual(['add', 'remove']);
  });

  it('Q3: both agent:error and phase:<phase> present → three-item remove list', async () => {
    const removeCalls: string[][] = [];
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({
        labels: ['workflow:speckit-feature', 'failed:validate', 'agent:error', 'phase:validate'],
      })),
      removeLabels: vi.fn(async (_nwo, _n, labels: string[]) => {
        removeCalls.push(labels);
      }),
    });
    const out: string[] = [];
    await runResume(
      'generacy-ai/generacy#42',
      {},
      { loadConfig: baseLoad, gh, now: fixedNow, stdout: (l) => out.push(l) },
    );
    expect(removeCalls).toEqual([['failed:validate', 'agent:error', 'phase:validate']]);
    expect(out[0]).toContain('removed=[failed:validate,agent:error,phase:validate]');
  });

  it('Q3: neither agent:error nor phase:<phase> → single-item remove list [failed:<phase>]', async () => {
    const removeCalls: string[][] = [];
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({
        labels: ['workflow:speckit-feature', 'failed:validate'],
      })),
      removeLabels: vi.fn(async (_nwo, _n, labels: string[]) => {
        removeCalls.push(labels);
      }),
    });
    const out: string[] = [];
    await runResume(
      'generacy-ai/generacy#42',
      {},
      { loadConfig: baseLoad, gh, now: fixedNow, stdout: (l) => out.push(l) },
    );
    expect(removeCalls).toEqual([['failed:validate']]);
    // Log reports only actual mutations
    expect(out[0]).toContain('removed=[failed:validate]');
    expect(out[0]).not.toContain('agent:error');
    expect(out[0]).not.toContain('phase:validate');
  });

  it('Q5: prior-phase completed:<earlier-phase> chain is preserved untouched', async () => {
    const preservedLabels = [
      'completed:specify',
      'completed:clarify',
      'completed:plan',
      'completed:tasks',
      'completed:implement',
    ];
    const removeCalls: string[][] = [];
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({
        labels: [
          'workflow:speckit-feature',
          'failed:validate',
          'agent:error',
          'phase:validate',
          ...preservedLabels,
        ],
      })),
      removeLabels: vi.fn(async (_nwo, _n, labels: string[]) => {
        removeCalls.push(labels);
      }),
    });
    await runResume(
      'generacy-ai/generacy#42',
      {},
      { loadConfig: baseLoad, gh, now: fixedNow, stdout: () => {} },
    );
    for (const call of removeCalls) {
      for (const preserved of preservedLabels) {
        expect(call).not.toContain(preserved);
      }
    }
  });
});
