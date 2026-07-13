import { describe, expect, it } from 'vitest';
import { runOnePoll } from '../watch/poll-loop.js';
import { FakeGh, makeIssue, makePr } from './helpers/fake-gh.js';

describe('runOnePoll', () => {
  it('returns a snapshot map and empty events on first poll', async () => {
    const gh = new FakeGh({
      issuesScript: [[makeIssue({ number: 1, labels: ['phase:plan', 'workflow:speckit-feature'] })]],
    });
    const { curr, events } = await runOnePoll(new Map(), {
      gh,
      refs: [{ repo: 'o/r', number: 1 }],
      epicOwnerRepo: 'o/r',
      now: () => '2026-06-26T00:00:00.000Z',
    });
    expect(events).toEqual([]);
    expect(curr.size).toBe(1);
    const snap = [...curr.values()][0];
    expect(snap?.kind).toBe('issue');
    expect(snap?.classified.state).toBe('active');
  });

  it('emits a label-change event on the second poll when classification flips', async () => {
    const gh = new FakeGh({
      issuesScript: [
        [makeIssue({ number: 1, labels: ['phase:plan'] })],
        [makeIssue({ number: 1, labels: ['waiting-for:plan-review'] })],
      ],
    });
    const baseline = await runOnePoll(new Map(), {
      gh,
      refs: [{ repo: 'o/r', number: 1 }],
      epicOwnerRepo: 'o/r',
    });
    const next = await runOnePoll(baseline.curr, {
      gh,
      refs: [{ repo: 'o/r', number: 1 }],
      epicOwnerRepo: 'o/r',
    });
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.event).toBe('label-change');
    expect(next.events[0]?.from).toBe('active');
    expect(next.events[0]?.to).toBe('waiting');
  });

  it('classifies PRs via URL match', async () => {
    const gh = new FakeGh({
      issuesScript: [
        [makePr({ number: 11, labels: ['workflow:speckit-feature'] })],
      ],
      checksByPr: { 'o/r#11': [{ name: 'lint', state: 'SUCCESS' }] },
    });
    const { curr } = await runOnePoll(new Map(), {
      gh,
      refs: [{ repo: 'o/r', number: 11 }],
      epicOwnerRepo: 'o/r',
    });
    const snap = [...curr.values()][0];
    expect(snap?.kind).toBe('pr');
    if (snap?.kind === 'pr') {
      expect(snap.lifecycle).toBe('open');
      expect(snap.checksRollup).toBe('success');
    }
  });
});
