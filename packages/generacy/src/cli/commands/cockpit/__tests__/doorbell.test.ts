import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runDoorbell, classifyForm } from '../doorbell.js';
import { EpicEventBus } from '../mcp/event-bus.js';
import type { Acquired } from '../mcp/event-bus-registry.js';
import type { CockpitStreamEvent } from '../watch/stream-event.js';

function makeIssueTransition(number: number): CockpitStreamEvent {
  return {
    type: 'issue-transition',
    ts: '2026-07-11T00:00:00.000Z',
    repo: 'generacy-ai/generacy',
    kind: 'issue',
    number,
    from: null,
    to: 'waiting:clarification',
    sourceLabel: 'waiting-for:clarification',
    url: `https://github.com/generacy-ai/generacy/issues/${number}`,
    event: 'label-change',
    labels: ['waiting-for:clarification'],
  };
}

function makeEpicComplete(): CockpitStreamEvent {
  return {
    type: 'epic-complete',
    epicRepo: 'generacy-ai/generacy',
    epicNumber: 100,
    ts: '2026-07-11T00:00:00.000Z',
  };
}

interface FakeStdout {
  writes: string[];
  write(chunk: string, cb?: () => void): boolean;
}

function makeStdout(): FakeStdout {
  return {
    writes: [],
    write(chunk: string, cb?: () => void): boolean {
      this.writes.push(chunk);
      if (cb) cb();
      return true;
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

function fakeAcquire(bus: EpicEventBus): {
  acquireBus: (opts: { epicRef: string }) => Promise<Acquired>;
  released: { count: number };
  seen: { epicRef: string | undefined };
} {
  const released = { count: 0 };
  const seen: { epicRef: string | undefined } = { epicRef: undefined };
  return {
    acquireBus: async (opts) => {
      seen.epicRef = opts.epicRef;
      return {
        bus,
        release: () => {
          released.count += 1;
        },
      };
    },
    released,
    seen,
  };
}

function recordExit(exitCalls: number[]): (code: number) => void {
  return (code: number) => {
    exitCalls.push(code);
  };
}

describe('classifyForm (unit)', () => {
  it('classifies Form 1 (positional only)', () => {
    expect(classifyForm('owner/repo#5', {})).toEqual({
      kind: 'form-1',
      ref: 'owner/repo#5',
    });
  });

  it('classifies Form 2 (positional + --tracking)', () => {
    expect(classifyForm('owner/repo#5', { tracking: true })).toEqual({
      kind: 'form-2',
      ref: 'owner/repo#5',
    });
  });

  it('classifies Form 3 (--new)', () => {
    expect(classifyForm(undefined, { new: 'title' })).toEqual({
      kind: 'form-3',
      title: 'title',
    });
  });

  it('rejects missing positional (all flags off)', () => {
    expect(classifyForm(undefined, {})).toEqual({ kind: 'missing-positional' });
  });

  it('rejects missing positional with --tracking only', () => {
    expect(classifyForm(undefined, { tracking: true })).toEqual({
      kind: 'missing-positional',
    });
  });

  it('rejects positional + --new', () => {
    expect(classifyForm('owner/repo#5', { new: 'title' })).toEqual({
      kind: 'conflicting-flags',
      reason: 'positional-with-new',
    });
  });

  it('rejects --tracking + --new', () => {
    expect(classifyForm(undefined, { tracking: true, new: 'title' })).toEqual({
      kind: 'conflicting-flags',
      reason: 'tracking-with-new',
    });
  });
});

describe('runDoorbell', () => {
  let stderrOut = '';
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrOut = '';
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrOut += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('T1 — Form 1 subscribes and emits armed first, then one line per bus.emit', async () => {
    const bus = new EpicEventBus({ epic: 'owner/repo#5' });
    const { acquireBus, released } = fakeAcquire(bus);
    const stdout = makeStdout();
    const exitCalls: number[] = [];
    const abortController = new AbortController();

    const runPromise = runDoorbell(
      'owner/repo#5',
      {},
      {
        acquireBus,
        stdout,
        exit: recordExit(exitCalls),
        abortSignal: abortController.signal,
      },
    );

    await flush();
    expect(stdout.writes[0]).toBe('armed\n');

    bus.emit(makeIssueTransition(1));
    await flush();
    expect(stdout.writes).toEqual(['armed\n', 'issue-transition\n']);

    abortController.abort();
    const code = await runPromise;
    expect(code).toBe(0);
    expect(exitCalls).toEqual([0]);
    expect(released.count).toBe(1);
  });

  it('T2 — Form 2 forwards the positional to acquireBus unchanged', async () => {
    const bus = new EpicEventBus({ epic: 'owner/repo#5' });
    const { acquireBus, seen } = fakeAcquire(bus);
    const stdout = makeStdout();
    const exitCalls: number[] = [];
    const abortController = new AbortController();

    const runPromise = runDoorbell(
      'owner/repo#5',
      { tracking: true },
      {
        acquireBus,
        stdout,
        exit: recordExit(exitCalls),
        abortSignal: abortController.signal,
      },
    );

    await flush();
    expect(seen.epicRef).toBe('owner/repo#5');
    expect(stdout.writes).toEqual(['armed\n']);

    abortController.abort();
    await runPromise;
  });

  it('T3 — Form 3 writes only armed and does NOT call acquireBus', async () => {
    const stdout = makeStdout();
    let acquireCalled = false;
    const exitCalls: number[] = [];
    const abortController = new AbortController();

    const runPromise = runDoorbell(
      undefined,
      { new: 'title' },
      {
        acquireBus: (async () => {
          acquireCalled = true;
          throw new Error('should not be called');
        }) as never,
        stdout,
        exit: recordExit(exitCalls),
        abortSignal: abortController.signal,
      },
    );

    await flush();
    expect(acquireCalled).toBe(false);
    expect(stdout.writes).toEqual(['armed\n']);

    abortController.abort();
    const code = await runPromise;
    expect(code).toBe(0);
    expect(exitCalls).toEqual([0]);
  });

  it('T4 — missing positional exits 2 with the exact error copy', async () => {
    const stdout = makeStdout();
    const exitCalls: number[] = [];

    const code = await runDoorbell(
      undefined,
      {},
      { stdout, exit: recordExit(exitCalls) },
    );

    expect(exitCalls).toEqual([2]);
    expect(code).toBe(2);
    expect(stderrOut).toBe('cockpit doorbell: parse issue: issue argument is required\n');
  });

  it('T5 — --tracking + --new exits 2 with the exact error copy', async () => {
    const stdout = makeStdout();
    const exitCalls: number[] = [];

    const code = await runDoorbell(
      undefined,
      { tracking: true, new: 'title' },
      { stdout, exit: recordExit(exitCalls) },
    );

    expect(exitCalls).toEqual([2]);
    expect(code).toBe(2);
    expect(stderrOut).toBe(
      'cockpit doorbell: --tracking and --new are mutually exclusive\n',
    );
  });

  it('rejects positional + --new with the exact error copy', async () => {
    const stdout = makeStdout();
    const exitCalls: number[] = [];

    const code = await runDoorbell(
      'owner/repo#5',
      { new: 'title' },
      { stdout, exit: recordExit(exitCalls) },
    );

    expect(exitCalls).toEqual([2]);
    expect(code).toBe(2);
    expect(stderrOut).toBe(
      'cockpit doorbell: --new does not accept a positional argument\n',
    );
  });

  it('T6 — SIGTERM path (via abortSignal): unsubscribe and release both called, exit(0)', async () => {
    const bus = new EpicEventBus({ epic: 'owner/repo#5' });
    const { acquireBus, released } = fakeAcquire(bus);
    const stdout = makeStdout();
    const exitCalls: number[] = [];
    const abortController = new AbortController();

    const runPromise = runDoorbell(
      'owner/repo#5',
      {},
      {
        acquireBus,
        stdout,
        exit: recordExit(exitCalls),
        abortSignal: abortController.signal,
      },
    );

    await flush();
    expect(stdout.writes[0]).toBe('armed\n');

    abortController.abort();
    const code = await runPromise;
    expect(code).toBe(0);
    expect(exitCalls).toEqual([0]);
    expect(released.count).toBe(1);

    // No more writes should happen after teardown.
    const writesBefore = stdout.writes.length;
    bus.emit(makeIssueTransition(999));
    await flush();
    expect(stdout.writes.length).toBe(writesBefore);
  });

  it('T7 — --exit-on-epic-complete: emit epic-complete triggers exit(0) after drain', async () => {
    const bus = new EpicEventBus({ epic: 'owner/repo#5' });
    const { acquireBus, released } = fakeAcquire(bus);
    const stdout = makeStdout();
    const exitCalls: number[] = [];
    const abortController = new AbortController();

    const runPromise = runDoorbell(
      'owner/repo#5',
      { exitOnEpicComplete: true },
      {
        acquireBus,
        stdout,
        exit: recordExit(exitCalls),
        abortSignal: abortController.signal,
      },
    );

    await flush();
    bus.emit(makeEpicComplete());

    const code = await runPromise;
    expect(code).toBe(0);
    expect(stdout.writes).toContain('epic-complete\n');
    expect(exitCalls).toEqual([0]);
    expect(released.count).toBe(1);
  });

  it('T8 — default post-epic-complete keeps polling (no exit without --exit-on-epic-complete)', async () => {
    const bus = new EpicEventBus({ epic: 'owner/repo#5' });
    const { acquireBus } = fakeAcquire(bus);
    const stdout = makeStdout();
    const exitCalls: number[] = [];
    const abortController = new AbortController();

    const runPromise = runDoorbell(
      'owner/repo#5',
      {},
      {
        acquireBus,
        stdout,
        exit: recordExit(exitCalls),
        abortSignal: abortController.signal,
      },
    );

    await flush();
    bus.emit(makeEpicComplete());
    await flush();
    bus.emit(makeIssueTransition(2));
    await flush();

    expect(stdout.writes).toEqual([
      'armed\n',
      'epic-complete\n',
      'issue-transition\n',
    ]);
    expect(exitCalls).toEqual([]);

    abortController.abort();
    const code = await runPromise;
    expect(code).toBe(0);
    expect(exitCalls).toEqual([0]);
  });
});
