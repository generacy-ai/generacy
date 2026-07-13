import { describe, expect, it } from 'vitest';
import { runOnePoll } from '../watch/poll-loop.js';
import { FakeGh, makeIssue, makePr } from './helpers/fake-gh.js';

describe('watch is a read-only sensor', () => {
  it('runOnePoll never calls addLabels / removeLabels (strict-mode runner asserts on call)', async () => {
    const gh = new FakeGh({
      issuesScript: [
        [
          makeIssue({ number: 1, labels: ['phase:plan'] }),
          makePr({ number: 2, labels: ['workflow:speckit-feature'] }),
        ],
        [
          makeIssue({ number: 1, labels: ['waiting-for:plan-review'], state: 'CLOSED' }),
          makePr({ number: 2, labels: ['phase:plan'], state: 'CLOSED' }),
        ],
      ],
      strict: true,
    });

    const refs = [
      { repo: 'o/r', number: 1 },
      { repo: 'o/r', number: 2 },
    ];
    const baseline = await runOnePoll(new Map(), {
      gh,
      refs,
      epicOwnerRepo: 'o/r',
    });
    await runOnePoll(baseline.curr, {
      gh,
      refs,
      epicOwnerRepo: 'o/r',
    });

    const mutationCalls = gh.calls.filter(
      (c) => c.method === 'addLabels' || c.method === 'removeLabels',
    );
    expect(mutationCalls).toEqual([]);
  });
});
