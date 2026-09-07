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
    });
    const next = await runOnePoll(baseline.curr, {
      gh,
      refs: [{ repo: 'o/r', number: 1 }],
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
    });
    const snap = [...curr.values()][0];
    expect(snap?.kind).toBe('pr');
    if (snap?.kind === 'pr') {
      expect(snap.lifecycle).toBe('open');
      expect(snap.checksRollup).toBe('success');
    }
  });

  // SC-001 / T013 — the post-filter drops a foreign ref the lookup surfaces,
  // independent of the query form. Pins `filterToRefSet` in the poll path.
  it('drops an out-of-scope issue the lookup returns (no snapshot, no event)', async () => {
    const gh = new FakeGh({
      lookupByRepo: (_repo, _numbers) => [
        makeIssue({ number: 1, labels: ['phase:plan'] }),
        // Foreign ref not in the epic's resolved set — must be filtered out.
        makeIssue({ number: 99, labels: ['phase:plan'] }),
      ],
    });
    const { curr, events } = await runOnePoll(new Map(), {
      gh,
      refs: [{ repo: 'o/r', number: 1 }],
    });
    expect(curr.size).toBe(1);
    expect([...curr.values()][0]?.number).toBe(1);
    expect(events).toEqual([]);
  });

  // SC-002 / T014 — a genuine transition still emits through the lookup path.
  it('emits a genuine label-change transition via the lookup path', async () => {
    const gh = new FakeGh({
      lookupByRepo: (() => {
        let call = 0;
        return (_repo: string, _numbers: number[]) => {
          call += 1;
          return call === 1
            ? [makeIssue({ number: 1, labels: ['phase:plan'] })]
            : [makeIssue({ number: 1, labels: ['waiting-for:plan-review'] })];
        };
      })(),
    });
    const baseline = await runOnePoll(new Map(), {
      gh,
      refs: [{ repo: 'o/r', number: 1 }],
    });
    const next = await runOnePoll(baseline.curr, {
      gh,
      refs: [{ repo: 'o/r', number: 1 }],
    });
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.event).toBe('label-change');
    expect(next.events[0]?.from).toBe('active');
    expect(next.events[0]?.to).toBe('waiting');
  });

  // SC-004 / FR-003 / T015 — a PR ref from the epic body reaches the PR branch;
  // lifecycle + checks rollup are populated (no dead branch on the poll path).
  it('routes a PR ref to the PR branch with lifecycle and checks rollup', async () => {
    const gh = new FakeGh({
      lookupByRepo: (_repo, _numbers) => [
        makePr({ number: 11, labels: ['workflow:speckit-feature'] }),
      ],
      checksByPr: { 'o/r#11': [{ name: 'lint', state: 'SUCCESS' }] },
    });
    const { curr } = await runOnePoll(new Map(), {
      gh,
      refs: [{ repo: 'o/r', number: 11 }],
    });
    const snap = [...curr.values()][0];
    expect(snap?.kind).toBe('pr');
    if (snap?.kind === 'pr') {
      expect(snap.lifecycle).toBe('open');
      expect(snap.checksRollup).toBe('success');
    }
  });
});
