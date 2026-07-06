import { describe, it, expect, vi } from 'vitest';
import { runState } from '../state.js';
import type { CockpitGh } from '../gh-ext.js';

const baseLoad = vi.fn(async () => ({
  config: {},
  source: 'defaults' as const,
  warnings: [],
}));

function stubGh(overrides: Partial<CockpitGh> = {}): CockpitGh {
  return {
    fetchIssueLabels: vi.fn(async () => ({ labels: [] })),
    fetchIssueState: vi.fn(),
    postIssueComment: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    fetchIssueTimeline: vi.fn(),
    fetchIssueComments: vi.fn(),
    getCurrentUser: vi.fn(),
    findOpenPrForBranch: vi.fn(),
    prDiffNames: vi.fn(),
    prDiffPatch: vi.fn(),
    ...overrides,
  } as CockpitGh;
}

describe('cockpit state', () => {
  it('prints text classification for "active" tier', async () => {
    const out: string[] = [];
    const gh = stubGh({ fetchIssueLabels: vi.fn(async () => ({ labels: ['phase:plan'] })) });
    await runState('generacy-ai/generacy#123', {}, {
      loadConfig: baseLoad,
      gh,
      stdout: (l) => out.push(l),
    });
    expect(out).toEqual(['generacy-ai/generacy#123  active  phase:plan']);
  });

  it('--json emits ClassifyStateOutput shape', async () => {
    const out: string[] = [];
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => ({ labels: ['waiting-for:clarification'] })),
    });
    await runState('generacy-ai/generacy#123', { json: true }, {
      loadConfig: baseLoad,
      gh,
      stdout: (l) => out.push(l),
    });
    const parsed = JSON.parse(out[0]!);
    expect(parsed).toEqual({
      issue: 'generacy-ai/generacy#123',
      state: 'waiting',
      sourceLabel: 'waiting-for:clarification',
    });
  });

  it('classifies all six curated tiers (SC-003)', async () => {
    const cases: Array<{ labels: string[]; state: string; source: string }> = [
      { labels: ['type:feature'], state: 'pending', source: 'type:feature' },
      { labels: ['phase:implement'], state: 'active', source: 'phase:implement' },
      { labels: ['waiting-for:clarification'], state: 'waiting', source: 'waiting-for:clarification' },
      { labels: ['failed:plan'], state: 'error', source: 'failed:plan' },
      { labels: ['completed:epic-approval'], state: 'terminal', source: 'completed:epic-approval' },
      { labels: ['some-random-label-not-in-vocab'], state: 'unknown', source: '' },
    ];
    for (const c of cases) {
      const out: string[] = [];
      const gh = stubGh({ fetchIssueLabels: vi.fn(async () => ({ labels: c.labels })) });
      await runState('generacy-ai/generacy#1', { json: true }, {
        loadConfig: baseLoad,
        gh,
        stdout: (l) => out.push(l),
      });
      const parsed = JSON.parse(out[0]!);
      expect(parsed.state).toBe(c.state);
      expect(parsed.sourceLabel).toBe(c.source);
    }
  });

  it('throws CockpitExit(1) on gh fetch failure', async () => {
    const gh = stubGh({
      fetchIssueLabels: vi.fn(async () => {
        throw new Error('gh issue view failed (exit 1): not found');
      }),
    });
    await expect(
      runState('generacy-ai/generacy#1', {}, { loadConfig: baseLoad, gh, stdout: () => {} }),
    ).rejects.toMatchObject({ name: 'CockpitExit', code: 1 });
  });

  it('throws CockpitExit(2) on a bare-number ref (repos are not configured)', async () => {
    await expect(
      runState('42', {}, { loadConfig: baseLoad, gh: stubGh(), stdout: () => {} }),
    ).rejects.toMatchObject({ name: 'CockpitExit', code: 2 });
  });
});
