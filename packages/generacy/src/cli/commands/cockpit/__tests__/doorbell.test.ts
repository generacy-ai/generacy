import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runDoorbell, classifyForm } from '../doorbell.js';
import { EpicEventBus } from '../mcp/event-bus.js';
import type { Acquired } from '../mcp/event-bus-registry.js';
import type { CockpitStreamEvent } from '../watch/stream-event.js';
import { AnswersFileSource } from '../doorbell/answers-file-source.js';
import { SmeeDoorbellSource } from '../doorbell/smee-source.js';

function makeIssueTransition(number: number): CockpitStreamEvent {
  return {
    type: 'issue-transition',
    ts: '2026-07-11T00:00:00.000Z',
    repo: 'generacy-ai/generacy',
    kind: 'issue',
    number,
    from: null,
    to: 'waiting',
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
    const nonEmpty = stdout.writes.filter((w) => w.length > 0);
    expect(nonEmpty[0]).toBe('armed\n');
    const parsedFirst = JSON.parse(nonEmpty[1]!.slice(0, -1)) as { type: string };
    expect(parsedFirst.type).toBe('issue-transition');

    abortController.abort();
    const code = await runPromise;
    expect(code).toBe(0);
    expect(exitCalls).toEqual([0]);
    // Two acquires + releases: one for poll-mode subscribe, one for the
    // answers-file tailer bridge (#1023).
    expect(released.count).toBe(2);
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
    // Two acquires + releases (poll subscribe + answers tailer, #1023).
    expect(released.count).toBe(2);

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
    const types = stdout.writes
      .filter((w) => w !== 'armed\n' && w.length > 0)
      .map((w) => (JSON.parse(w.slice(0, -1)) as { type: string }).type);
    expect(types).toContain('epic-complete');
    expect(exitCalls).toEqual([0]);
    // Two acquires + releases (poll subscribe + answers tailer, #1023).
    expect(released.count).toBe(2);
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

    const nonEmpty = stdout.writes.filter((w) => w.length > 0);
    expect(nonEmpty[0]).toBe('armed\n');
    const types = nonEmpty
      .slice(1)
      .map((w) => (JSON.parse(w.slice(0, -1)) as { type: string }).type);
    expect(types).toEqual(['epic-complete', 'issue-transition']);
    expect(exitCalls).toEqual([]);

    abortController.abort();
    const code = await runPromise;
    expect(code).toBe(0);
    expect(exitCalls).toEqual([0]);
  });
});

/**
 * Answers-file tailer wiring assertions (#1023). Uses a constructor spy for
 * `AnswersFileSource` — the tailer's own filesystem behaviour is exercised
 * by `doorbell/__tests__/answers-file-source.*.test.ts`.
 */
describe('runDoorbell — answers-file tailer wiring (#1023)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  interface FakeTailer {
    startCalls: number;
    stopCalls: number;
    opts: ConstructorParameters<typeof AnswersFileSource>[0] | null;
    instance: AnswersFileSource;
  }

  function makeFakeTailerFactory(): {
    factory: (opts: ConstructorParameters<typeof AnswersFileSource>[0]) => AnswersFileSource;
    captured: FakeTailer;
  } {
    const captured: FakeTailer = {
      startCalls: 0,
      stopCalls: 0,
      opts: null,
      instance: null as unknown as AnswersFileSource,
    };
    const factory = (
      opts: ConstructorParameters<typeof AnswersFileSource>[0],
    ): AnswersFileSource => {
      captured.opts = opts;
      const stub = {
        start: async () => {
          captured.startCalls += 1;
        },
        stop: async () => {
          captured.stopCalls += 1;
        },
        getState: () => 'tailing' as const,
      };
      captured.instance = stub as unknown as AnswersFileSource;
      return captured.instance;
    };
    return { factory, captured };
  }

  it('form-1 poll mode: constructs AnswersFileSource with correct epicRef and starts it', async () => {
    const bus = new EpicEventBus({ epic: 'owner/repo#42' });
    const { acquireBus } = fakeAcquire(bus);
    const { factory, captured } = makeFakeTailerFactory();
    const stdout = makeStdout();
    const abort = new AbortController();

    const runPromise = runDoorbell(
      'owner/repo#42',
      {},
      {
        acquireBus,
        answersFileSourceFactory: factory,
        stdout,
        exit: recordExit([]),
        abortSignal: abort.signal,
      },
    );

    await flush();
    expect(captured.opts?.epicRef).toBe('owner/repo#42');
    expect(captured.startCalls).toBe(1);

    abort.abort();
    await runPromise;
    // Stopped cleanly on teardown.
    expect(captured.stopCalls).toBe(1);
  });

  it('form-2 tracking mode: constructs AnswersFileSource with the tracking-ref epicRef', async () => {
    const bus = new EpicEventBus({ epic: 'owner/repo#99' });
    const { acquireBus } = fakeAcquire(bus);
    const { factory, captured } = makeFakeTailerFactory();
    const stdout = makeStdout();
    const abort = new AbortController();

    const runPromise = runDoorbell(
      'owner/repo#99',
      { tracking: true },
      {
        acquireBus,
        answersFileSourceFactory: factory,
        stdout,
        exit: recordExit([]),
        abortSignal: abort.signal,
      },
    );

    await flush();
    expect(captured.opts?.epicRef).toBe('owner/repo#99');
    expect(captured.startCalls).toBe(1);

    abort.abort();
    await runPromise;
    expect(captured.stopCalls).toBe(1);
  });

  it('form-1 smee mode: tailer is still constructed and started (runs in parallel with smee source)', async () => {
    const bus = new EpicEventBus({ epic: 'owner/repo#7' });
    const { acquireBus } = fakeAcquire(bus);
    const { factory, captured } = makeFakeTailerFactory();
    const stdout = makeStdout();
    const abort = new AbortController();

    const fakeSmeeSource = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const smeeFactory = vi.fn().mockReturnValue(fakeSmeeSource);

    const runPromise = runDoorbell(
      'owner/repo#7',
      {},
      {
        acquireBus,
        answersFileSourceFactory: factory,
        smeeSourceFactory: smeeFactory as unknown as never,
        gh: {} as unknown as never,
        env: { COCKPIT_DOORBELL_SMEE_URL: 'https://smee.io/xyz' },
        fs: {
          readFile: async () => {
            const err = new Error('nope') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
          },
        },
        channelFilePath: '/tmp/nonexistent-1023',
        stdout,
        exit: recordExit([]),
        abortSignal: abort.signal,
      },
    );

    await flush();
    // Smee source started (mode is smee).
    expect(smeeFactory).toHaveBeenCalled();
    // Tailer also constructed + started concurrently.
    expect(captured.opts?.epicRef).toBe('owner/repo#7');
    expect(captured.startCalls).toBe(1);

    abort.abort();
    await runPromise;
    expect(captured.stopCalls).toBe(1);
    expect(fakeSmeeSource.stop).toHaveBeenCalled();
  });

  it('SIGINT-style abort: tailer.stop() is invoked alongside source teardown', async () => {
    const bus = new EpicEventBus({ epic: 'owner/repo#8' });
    const { acquireBus, released } = fakeAcquire(bus);
    const { factory, captured } = makeFakeTailerFactory();
    const stdout = makeStdout();
    const abort = new AbortController();

    const runPromise = runDoorbell(
      'owner/repo#8',
      {},
      {
        acquireBus,
        answersFileSourceFactory: factory,
        stdout,
        exit: recordExit([]),
        abortSignal: abort.signal,
      },
    );

    await flush();
    expect(captured.startCalls).toBe(1);
    expect(captured.stopCalls).toBe(0);

    abort.abort();
    const code = await runPromise;
    expect(code).toBe(0);
    // Tailer stopped exactly once.
    expect(captured.stopCalls).toBe(1);
    // Both bus references released (poll + tailer).
    expect(released.count).toBe(2);
  });

  it('bridge onEvent writes stdout via lineForEvent AND emits to bus', async () => {
    const bus = new EpicEventBus({ epic: 'owner/repo#9' });
    const { acquireBus } = fakeAcquire(bus);
    const { factory, captured } = makeFakeTailerFactory();
    const stdout = makeStdout();
    const abort = new AbortController();

    const runPromise = runDoorbell(
      'owner/repo#9',
      {},
      {
        acquireBus,
        answersFileSourceFactory: factory,
        stdout,
        exit: recordExit([]),
        abortSignal: abort.signal,
      },
    );

    await flush();
    const bridge = captured.opts!.onEvent;
    expect(bridge).toBeDefined();

    // Drive the bridge with a synthetic gate-answer event.
    const priorStdoutCount = stdout.writes.length;
    const priorCursor = (bus as unknown as { nextCursor: number }).nextCursor;
    await bridge({
      type: 'gate-answer',
      ts: '2027-01-14T12:00:00.000Z',
      gateId: 'g-test',
      deliveryId: 'd-test',
      epic: 'owner/repo#9',
      line: {
        gateId: 'g-test',
        deliveryId: 'd-test',
        scope: { owner: 'owner', repo: 'repo', number: 9 },
        answer: {},
        answeredAt: '2027-01-14T12:00:00.000Z',
      },
    });

    // One stdout line appended.
    const newWrites = stdout.writes.slice(priorStdoutCount).filter((w) => w.length > 0);
    expect(newWrites).toHaveLength(1);
    const parsed = JSON.parse(newWrites[0]!.slice(0, -1)) as { type: string; gateId: string };
    expect(parsed.type).toBe('gate-answer');
    expect(parsed.gateId).toBe('g-test');
    // Bus cursor advanced.
    const newCursor = (bus as unknown as { nextCursor: number }).nextCursor;
    expect(newCursor).toBe(priorCursor + 1);

    abort.abort();
    await runPromise;
  });
});
// Suppress unused import warning: SmeeDoorbellSource type is imported for
// documentation of the sibling factory shape; runtime uses smeeSourceFactory.
void SmeeDoorbellSource;
