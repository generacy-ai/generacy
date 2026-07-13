import { describe, it, expect, vi } from 'vitest';
import type { Issue } from '@generacy-ai/cockpit';
import { FakeGh, makeIssue } from '../../__tests__/helpers/fake-gh.js';
import { cockpitQueue } from '../tools/cockpit_queue.js';

const stubLoadConfig = vi.fn(async () => ({
  config: { assignee: 'octocat' },
  source: 'defaults' as const,
  warnings: [],
}));

function epicBody(refs: string[]): string {
  return ['### specify', ...refs.map((r) => `- [ ] ${r}`)].join('\n');
}

describe('cockpit_queue parity', () => {
  it('returns queued/skipped arrays derived from row eligibility', async () => {
    const body = epicBody(['owner/repo#1', 'owner/repo#2']);
    const gh = new FakeGh({
      bodyByIssue: { 'owner/epic#42': body },
      issuesByQuery: (): Issue[] => [
        makeIssue({
          number: 1,
          url: 'https://github.com/owner/repo/issues/1',
          labels: ['process:speckit-feature'],
        }),
        makeIssue({ number: 2, url: 'https://github.com/owner/repo/issues/2' }),
      ],
    });
    // Give FakeGh an explicit fetchIssueState behavior for classifyRow.
    (gh as unknown as { fetchIssueState: (r: string, n: number) => Promise<unknown> }).fetchIssueState =
      async (_r: string, n: number) => ({
        state: 'OPEN' as const,
        stateReason: null,
        title: `Issue ${n}`,
        labels: n === 1 ? ['process:speckit-feature'] : [],
        assignees: [],
      });

    const result = await cockpitQueue(
      {
        epic: { owner: 'owner', repo: 'epic', number: 42 },
        phase: 'specify',
      },
      { gh, cockpitGh: gh, loadConfig: stubLoadConfig as never },
    );
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.phase).toBe('specify');
    expect(result.data.queued.length + result.data.skipped.length).toBe(2);
    expect(
      result.data.skipped.some((s) => s.number === 1 && s.reason === 'already-labeled'),
    ).toBe(true);
  });
});
