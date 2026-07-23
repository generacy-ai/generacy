import { describe, expect, it, vi } from 'vitest';
import {
  AnswersFileSource,
  type AnswersFileSourceOptions,
  type FsFacade,
  type FsFileHandle,
  type FsStatResult,
} from '../answers-file-source.js';
import { CockpitStreamEventSchema } from '../../watch/stream-event.js';
import { lineForEvent } from '../subscribe.js';
import type { GateAnswerEvent } from '../../watch/gate-answer.js';

/**
 * In-memory fs façade for pure unit coverage. Backed by a single string of
 * NDJSON content; the tailer's stat/open/read walk the same buffer.
 */
function makeMemFs(): {
  fs: FsFacade;
  setContent(content: string, ino?: number): void;
  removeFile(): void;
  removeDir(): void;
} {
  let content: string | null = null;
  let ino = 1;
  let dirPresent = true;
  const filePath = '/mem/answers.ndjson';
  const parentDir = '/mem';
  const facade: FsFacade = {
    stat: async (p: string): Promise<FsStatResult> => {
      if (p === parentDir) {
        if (!dirPresent) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return { ino: 42, size: 4096 };
      }
      if (p === filePath) {
        if (content == null) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return { ino, size: Buffer.byteLength(content, 'utf-8') };
      }
      const err = new Error(`unexpected stat ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    },
    open: async (p: string, _flags: string): Promise<FsFileHandle> => {
      if (p !== filePath || content == null) {
        const err = new Error(`ENOENT open ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      const buf = Buffer.from(content, 'utf-8');
      return {
        read: async (out, off, len, pos) => {
          const start = pos;
          const end = Math.min(start + len, buf.length);
          const bytesRead = Math.max(0, end - start);
          if (bytesRead > 0) buf.copy(out, off, start, end);
          return { bytesRead };
        },
        close: async () => undefined,
      };
    },
    // No watch — tests use useFsWatch: false.
  };
  return {
    fs: facade,
    setContent: (c: string, i?: number) => {
      content = c;
      if (i !== undefined) ino = i;
    },
    removeFile: () => {
      content = null;
    },
    removeDir: () => {
      dirPresent = false;
      content = null;
    },
  };
}

function makeLogger(): {
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  return { warn: vi.fn(), info: vi.fn() };
}

function baseOptions(
  overrides: Partial<AnswersFileSourceOptions> = {},
): AnswersFileSourceOptions {
  return {
    epicRef: 'owner/repo#5',
    filePath: '/mem/answers.ndjson',
    onEvent: async () => undefined,
    logger: makeLogger(),
    useFsWatch: false,
    pollIntervalMs: 100,
    now: () => 1_800_000_000_000, // 2027-01-15T08:00:00.000Z
    ...overrides,
  };
}

/**
 * A well-formed FROZEN down-path gate-answer line (Shape 3). Default gateKey
 * issue-ref shares the bound epic's owner/repo so it passes the repo-scope
 * filter. `gateId` is a short opaque label (the tailer pins it `min(1)`, not
 * `length(24)` — format is validated upstream at the /cockpit/answers route).
 */
function goodLine(overrides: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      type: 'gate-answer',
      gateId: 'g1',
      gateKey: 'owner/repo#5:clarification:batch-abc',
      optionId: 'opt-1',
      freeText: null,
      actor: { userId: 'u1', email: 'op@example.com', displayName: 'Op' },
      answeredAt: '2027-01-14T12:00:00.000Z',
      deliveryId: 'd1',
      ...overrides,
    }) + '\n'
  );
}

describe('AnswersFileSource — constructor validation', () => {
  it('rejects invalid epicRef', () => {
    expect(
      () =>
        new AnswersFileSource(
          baseOptions({ epicRef: 'invalid' }),
        ),
    ).toThrow(/epicRef/);
  });

  it('rejects replayLineCap of zero', () => {
    expect(
      () =>
        new AnswersFileSource(
          baseOptions({ replayLineCap: 0 }),
        ),
    ).toThrow(/replayLineCap/);
  });

  it('rejects negative replayLineCap', () => {
    expect(
      () =>
        new AnswersFileSource(
          baseOptions({ replayLineCap: -1 }),
        ),
    ).toThrow(/replayLineCap/);
  });

  it('accepts Infinity for replayLineCap', () => {
    expect(
      () =>
        new AnswersFileSource(
          baseOptions({ replayLineCap: Infinity }),
        ),
    ).not.toThrow();
  });

  it('rejects pollIntervalMs below 100', () => {
    expect(
      () =>
        new AnswersFileSource(
          baseOptions({ pollIntervalMs: 50 }),
        ),
    ).toThrow(/pollIntervalMs/);
  });
});

describe('AnswersFileSource — line pipeline (unit)', () => {
  it('happy path: valid frozen line matching epicRef emits one event with flat answer fields', async () => {
    const mem = makeMemFs();
    mem.setContent(goodLine());
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).toHaveBeenCalledTimes(1);
    const event = onEvent.mock.calls[0]![0] as GateAnswerEvent;
    expect(event.type).toBe('gate-answer');
    expect(event.gateId).toBe('g1');
    expect(event.deliveryId).toBe('d1');
    expect(event.epic).toBe('owner/repo#5');
    // Flat frozen answer fields survive on line.* (no scope / nested-answer).
    expect(event.line.type).toBe('gate-answer');
    expect(event.line.gateKey).toBe('owner/repo#5:clarification:batch-abc');
    expect(event.line.optionId).toBe('opt-1');
    expect(event.line.freeText).toBeNull();
    expect(event.line.actor).toEqual({
      userId: 'u1',
      email: 'op@example.com',
      displayName: 'Op',
    });
    expect(event.ts).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it('accepts a pure free-text answer (optionId null, freeText string)', async () => {
    const mem = makeMemFs();
    mem.setContent(goodLine({ optionId: null, freeText: 'do the other thing' }));
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).toHaveBeenCalledTimes(1);
    const event = onEvent.mock.calls[0]![0] as GateAnswerEvent;
    expect(event.line.optionId).toBeNull();
    expect(event.line.freeText).toBe('do the other thing');
  });

  it('accepts a null-email / null-displayName actor (anonymous / partial profile)', async () => {
    const mem = makeMemFs();
    mem.setContent(
      goodLine({ actor: { userId: 'u9', email: null, displayName: null } }),
    );
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).toHaveBeenCalledTimes(1);
    const event = onEvent.mock.calls[0]![0] as GateAnswerEvent;
    expect(event.line.actor.userId).toBe('u9');
    expect(event.line.actor.email).toBeNull();
    expect(event.line.actor.displayName).toBeNull();
  });

  it('emitted event survives round-trip through CockpitStreamEventSchema + lineForEvent', async () => {
    const mem = makeMemFs();
    mem.setContent(goodLine());
    const captured: GateAnswerEvent[] = [];
    const src = new AnswersFileSource(
      baseOptions({
        fs: mem.fs,
        onEvent: async (e) => {
          captured.push(e);
        },
      }),
    );
    await src.start();
    await src.stop();

    const event = captured[0]!;
    const serialized = lineForEvent(event);
    const parsed = CockpitStreamEventSchema.parse(
      JSON.parse(serialized.slice(0, -1)),
    );
    expect(parsed).toEqual(event);
  });

  it('preserves unknown fields on line.* via .passthrough()', async () => {
    const mem = makeMemFs();
    mem.setContent(goodLine({ customField: 'hello', another: 42 }));
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent }),
    );
    await src.start();
    await src.stop();

    const event = onEvent.mock.calls[0]![0] as GateAnswerEvent & {
      line: { customField?: string; another?: number };
    };
    expect(event.line.customField).toBe('hello');
    expect(event.line.another).toBe(42);
  });

  it('missing type discriminator → skipped with logger.warn (guards the kind→type fix)', async () => {
    const mem = makeMemFs();
    // The OLD wrong shape used `kind:'gate-answer'` with no `type`; it must now
    // fail schema validation and be dropped as malformed.
    mem.setContent(
      JSON.stringify({
        kind: 'gate-answer',
        gateId: 'g1',
        gateKey: 'owner/repo#5:clarification:b',
        optionId: 'opt-1',
        freeText: null,
        actor: { userId: 'u1', email: 'op@example.com', displayName: 'Op' },
        answeredAt: '2027-01-14T12:00:00.000Z',
        deliveryId: 'd1',
      }) + '\n',
    );
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, logger }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.warn.mock.calls[0]![0]).toMatch(/malformed line/);
  });

  it('missing gateId → skipped with logger.warn, no onEvent', async () => {
    const mem = makeMemFs();
    mem.setContent(
      JSON.stringify({
        type: 'gate-answer',
        gateKey: 'owner/repo#5:clarification:b',
        optionId: 'opt-1',
        freeText: null,
        actor: { userId: 'u1', email: 'op@example.com', displayName: 'Op' },
        answeredAt: '2027-01-14T12:00:00.000Z',
        deliveryId: 'd1',
      }) + '\n',
    );
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, logger }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(logger.warn.mock.calls[0]![0]).toMatch(/malformed line/);
  });

  it('empty-string gateId → skipped with warn', async () => {
    const mem = makeMemFs();
    mem.setContent(goodLine({ gateId: '' }));
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, logger }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('missing gateKey → skipped with warn', async () => {
    const mem = makeMemFs();
    mem.setContent(
      JSON.stringify({
        type: 'gate-answer',
        gateId: 'g1',
        optionId: 'opt-1',
        freeText: null,
        actor: { userId: 'u1', email: 'op@example.com', displayName: 'Op' },
        answeredAt: '2027-01-14T12:00:00.000Z',
        deliveryId: 'd1',
      }) + '\n',
    );
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, logger }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('missing actor → skipped with warn', async () => {
    const mem = makeMemFs();
    mem.setContent(
      JSON.stringify({
        type: 'gate-answer',
        gateId: 'g1',
        gateKey: 'owner/repo#5:clarification:b',
        optionId: 'opt-1',
        freeText: null,
        answeredAt: '2027-01-14T12:00:00.000Z',
        deliveryId: 'd1',
      }) + '\n',
    );
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, logger }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('optionId wrong type (number) → skipped with warn', async () => {
    const mem = makeMemFs();
    mem.setContent(goodLine({ optionId: 5 }));
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, logger }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('malformed JSON → skipped with warn naming byte offset', async () => {
    const mem = makeMemFs();
    const junk = 'this is not json\n' + goodLine();
    mem.setContent(junk);
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, logger }),
    );
    await src.start();
    await src.stop();

    // Malformed line skipped; valid line still emitted.
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
    const warnMsg = logger.warn.mock.calls[0]![0] as string;
    expect(warnMsg).toMatch(/byteOffset=0/);
    expect(warnMsg).toMatch(/malformed line/);
  });

  it('cross-repo line (foreign owner in gateKey) → dropped with logger.info naming gateId + scope + boundEpic', async () => {
    const mem = makeMemFs();
    mem.setContent(
      goodLine({ gateKey: 'other/repo#99:clarification:batch-x' }),
    );
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, logger }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
    const infoMsg = logger.info.mock.calls.find((c) =>
      (c[0] as string).includes('cross-epic drop'),
    )?.[0] as string | undefined;
    expect(infoMsg).toBeDefined();
    expect(infoMsg).toMatch(/gateId=g1/);
    expect(infoMsg).toMatch(/scope=other\/repo#99/);
    expect(infoMsg).toMatch(/boundEpic=owner\/repo#5/);
  });

  it('same-repo child-issue answer (different issue number) is NOT dropped', async () => {
    const mem = makeMemFs();
    // Bound epic is owner/repo#5; a gate opened on child issue owner/repo#42
    // must still be delivered (repo-scope, not issue-number, matching).
    mem.setContent(
      goodLine({ gateKey: 'owner/repo#42:implementation-review:abc123' }),
    );
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, logger }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).toHaveBeenCalledTimes(1);
    const infoDrops = logger.info.mock.calls.filter((c) =>
      (c[0] as string).includes('cross-epic drop'),
    );
    expect(infoDrops).toHaveLength(0);
  });

  it('non-issue gateKey target (filing/scope-drained tracking ref) is emitted, not scope-dropped', async () => {
    const mem = makeMemFs();
    // A gateKey whose issue-ref does not parse as owner/repo#N (e.g. a filing
    // draft target). The tailer cannot determine scope, so it emits.
    mem.setContent(
      goodLine({ gateKey: 'tracking-thread-7:filing:draft-hash-9' }),
    );
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('event.ts uses injected now() clock (deterministic)', async () => {
    const mem = makeMemFs();
    mem.setContent(goodLine());
    const nowValue = 1_700_000_000_000;
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({
        fs: mem.fs,
        onEvent,
        now: () => nowValue,
      }),
    );
    await src.start();
    await src.stop();

    const event = onEvent.mock.calls[0]![0] as GateAnswerEvent;
    expect(event.ts).toBe(new Date(nowValue).toISOString());
  });
});
