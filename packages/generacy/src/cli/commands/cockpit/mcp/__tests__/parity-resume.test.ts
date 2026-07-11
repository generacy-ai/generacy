import { describe, it, expect, vi } from 'vitest';
import type { GhWrapper, Issue } from '@generacy-ai/cockpit';
import { cockpitResume } from '../tools/cockpit_resume.js';

const stubLoadConfig = vi.fn(async () => ({
  config: {},
  source: 'defaults' as const,
  warnings: [],
}));

function stubGh(labels: string[] = []): GhWrapper {
  return {
    fetchIssueLabels: vi.fn(async () => ({ labels })),
    addLabels: vi.fn(async () => undefined),
    removeLabels: vi.fn(async () => undefined),
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

describe('cockpit_resume parity', () => {
  it('no-op: issue has no failed:* → action="no-op"', async () => {
    const gh = stubGh(['waiting-for:clarification']);
    const result = await cockpitResume(
      { issue: { owner: 'generacy-ai', repo: 'generacy', number: 917 } },
      { gh, loadConfig: stubLoadConfig as never },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.action).toBe('no-op');
    expect(result.data.targetPhase).toBeNull();
    expect(result.data.precedingGate).toBeNull();
    expect(result.data.labelsAdded).toEqual([]);
    expect(result.data.labelsRemoved).toEqual([]);
  });

  it('happy path: failed:implement → resumes with labels', async () => {
    const gh = stubGh(['failed:implement', 'agent:error']);
    const result = await cockpitResume(
      { issue: { owner: 'generacy-ai', repo: 'generacy', number: 917 } },
      { gh, loadConfig: stubLoadConfig as never },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.action).toBe('resumed');
    expect(result.data.targetPhase).toBe('implement');
    expect(result.data.labelsAdded.length).toBeGreaterThan(0);
    expect(result.data.labelsRemoved).toContain('failed:implement');
  });

  it('refusal: multiple failed:* → gate-refusal', async () => {
    const gh = stubGh(['failed:tasks', 'failed:implement']);
    const result = await cockpitResume(
      { issue: { owner: 'generacy-ai', repo: 'generacy', number: 917 } },
      { gh, loadConfig: stubLoadConfig as never },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('gate-refusal');
  });
});
