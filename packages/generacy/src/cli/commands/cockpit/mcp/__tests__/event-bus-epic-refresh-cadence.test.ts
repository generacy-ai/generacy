import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandRunner, GhWrapper, Issue } from '@generacy-ai/cockpit';
import { acquireEpicBus, _resetRegistryForTests } from '../event-bus-registry.js';

function stubRunner(): CommandRunner {
  return async () => ({ stdout: '', stderr: '', exitCode: 0 });
}

interface CountingGh {
  gh: GhWrapper;
  epicGetIssueCount: () => number;
}

function makeCountingGh(epicRepo: string, epicNumber: number): CountingGh {
  let epicGetIssueCount = 0;
  const gh: Partial<GhWrapper> = {
    async getIssue(repo, number): Promise<Issue> {
      if (repo === epicRepo && number === epicNumber) {
        epicGetIssueCount += 1;
        return {
          number,
          title: 'Epic',
          state: 'OPEN',
          stateReason: null,
          labels: [],
          url: `https://github.com/${repo}/issues/${number}`,
          body: `- [ ] ${epicRepo}#1\n`,
          createdAt: '',
        };
      }
      return {
        number,
        title: '',
        state: 'OPEN',
        stateReason: null,
        labels: [],
        url: `https://github.com/${repo}/issues/${number}`,
        body: '',
        createdAt: '',
      };
    },
    async listIssues(): Promise<Issue[]> {
      return [];
    },
  };
  return { gh: gh as GhWrapper, epicGetIssueCount: () => epicGetIssueCount };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

afterEach(() => {
  _resetRegistryForTests();
  vi.useRealTimers();
});

describe('event-bus resolveEpic cadence', () => {
  it('invokes resolveEpic on cycles 1, 11, 21, 31 (every 10th) and not in between', async () => {
    vi.useFakeTimers();
    const runner = stubRunner();
    const { gh, epicGetIssueCount } = makeCountingGh('generacy-ai/generacy', 999);
    const intervalMs = 1_000;

    const sub = await acquireEpicBus({
      epicRef: 'generacy-ai/generacy#999',
      runner,
      gh,
      intervalMs,
    });

    // Cycle 1 fires as the loop starts. resolveEpic runs because
    // state.currentResolved is null.
    await flush();
    expect(epicGetIssueCount()).toBe(1);

    // Drive 9 more cycles. None of them should call resolveEpic — the
    // end-of-cycle refresh gate only trips at cyclesSinceEpicRefresh >= 10.
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(intervalMs + 5);
      await flush();
    }
    expect(epicGetIssueCount()).toBe(1);

    // Cycle 11 — end-of-cycle refresh should fire.
    await vi.advanceTimersByTimeAsync(intervalMs + 5);
    await flush();
    expect(epicGetIssueCount()).toBe(2);

    // Cycles 12-20 — no refresh.
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(intervalMs + 5);
      await flush();
    }
    expect(epicGetIssueCount()).toBe(2);

    // Cycle 21 — refresh.
    await vi.advanceTimersByTimeAsync(intervalMs + 5);
    await flush();
    expect(epicGetIssueCount()).toBe(3);

    // Cycles 22-30 — no refresh.
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(intervalMs + 5);
      await flush();
    }
    expect(epicGetIssueCount()).toBe(3);

    // Cycle 31 — refresh.
    await vi.advanceTimersByTimeAsync(intervalMs + 5);
    await flush();
    expect(epicGetIssueCount()).toBe(4);

    sub.release();
  });
});
