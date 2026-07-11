import { describe, it, expect, vi } from 'vitest';
import type { GhWrapper, Issue } from '@generacy-ai/cockpit';
import { cockpitAdvance } from '../tools/cockpit_advance.js';

const stubLoadConfig = vi.fn(async () => ({
  config: {},
  source: 'defaults' as const,
  warnings: [],
}));

function stubGh(labels: string[] = []): GhWrapper {
  return {
    fetchIssueLabels: vi.fn(async () => ({ labels })),
    postIssueComment: vi.fn(async () => ({
      url: 'https://github.com/generacy-ai/generacy/issues/917#issuecomment-1',
    })),
    addLabel: vi.fn(async () => undefined),
    getCurrentUser: vi.fn(async () => 'octocat'),
    getIssue: vi.fn(async () => ({
      number: 917,
      title: 'x',
      state: 'OPEN',
      labels,
      url: 'https://github.com/generacy-ai/generacy/issues/917',
    } as Issue)),
    findOpenPrForBranch: vi.fn(),
    prDiffNames: vi.fn(),
    prDiffPatch: vi.fn(),
  } as unknown as GhWrapper;
}

describe('cockpit_advance parity', () => {
  it('happy path: returns structured advance envelope with commentUrl', async () => {
    const gh = stubGh(['waiting-for:clarification']);
    const result = await cockpitAdvance(
      {
        issue: { owner: 'generacy-ai', repo: 'generacy', number: 917 },
        gate: 'clarification',
      },
      { gh, loadConfig: stubLoadConfig as never, now: () => new Date('2026-07-11T00:00:00.000Z') },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.action).toBe('advanced');
    expect(result.data.completedLabel).toBe('completed:clarification');
    expect(result.data.commentUrl).toBeDefined();
  });

  it('idempotent no-op: completed:<gate> already present → action="already-advanced", noop=true', async () => {
    const gh = stubGh(['waiting-for:clarification', 'completed:clarification']);
    const result = await cockpitAdvance(
      {
        issue: { owner: 'generacy-ai', repo: 'generacy', number: 917 },
        gate: 'clarification',
      },
      { gh, loadConfig: stubLoadConfig as never },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.action).toBe('already-advanced');
    expect(result.data.noop).toBe(true);
  });

  it('refusal path: waiting-for:* differs from requested gate → gate-refusal', async () => {
    const gh = stubGh(['waiting-for:plan-review']);
    const result = await cockpitAdvance(
      {
        issue: { owner: 'generacy-ai', repo: 'generacy', number: 917 },
        gate: 'clarification',
      },
      { gh, loadConfig: stubLoadConfig as never },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('gate-refusal');
  });
});
