import { describe, it, expect, vi } from 'vitest';
import type { GhWrapper, Issue } from '@generacy-ai/cockpit';
import { cockpitMerge } from '../tools/cockpit_merge.js';

function stubGh(overrides: Partial<GhWrapper> = {}): GhWrapper {
  return {
    getIssue: vi.fn(async () => ({
      number: 950,
      title: 'x',
      state: 'OPEN',
      labels: ['type:pr'],
      url: 'https://github.com/generacy-ai/generacy/pull/950',
    } as Issue)),
    ...overrides,
  } as unknown as GhWrapper;
}

describe('cockpit_merge parity', () => {
  it('rejects issue number passed as pr (wrong-kind)', async () => {
    const gh = stubGh({
      getIssue: vi.fn(async () => ({
        number: 917,
        title: 'x',
        state: 'OPEN',
        labels: [],
        url: 'https://github.com/generacy-ai/generacy/issues/917',
      } as Issue)),
    });
    const result = await cockpitMerge(
      { pr: { owner: 'generacy-ai', repo: 'generacy', number: 917 } },
      { gh },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('wrong-kind');
  });

  it('gate-refusal when PR resolves as unresolved (no linked issue)', async () => {
    const gh = stubGh({
      resolveIssueToPRRef: vi.fn(async () => ({ kind: 'unresolved' })),
    });
    const result = await cockpitMerge(
      { pr: { owner: 'generacy-ai', repo: 'generacy', number: 950 } },
      { gh },
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(['gate-refusal', 'transport']).toContain(result.class);
  });
});
