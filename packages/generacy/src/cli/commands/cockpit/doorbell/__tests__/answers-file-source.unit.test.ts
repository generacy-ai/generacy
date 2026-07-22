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

function goodLine(overrides: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      gateId: 'g1',
      deliveryId: 'd1',
      scope: { owner: 'owner', repo: 'repo', number: 5 },
      answer: { text: 'yes' },
      answeredAt: '2027-01-14T12:00:00.000Z',
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
  it('happy path: valid line matching epicRef emits one event with correct shape', async () => {
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
    expect(event.line.scope).toEqual({ owner: 'owner', repo: 'repo', number: 5 });
    expect(event.ts).toBe(new Date(1_800_000_000_000).toISOString());
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

  it('missing gateId → skipped with logger.warn, no onEvent', async () => {
    const mem = makeMemFs();
    mem.setContent(
      JSON.stringify({
        deliveryId: 'd1',
        scope: { owner: 'owner', repo: 'repo', number: 5 },
        answer: 'x',
        answeredAt: '2027-01-14T12:00:00.000Z',
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

  it('missing scope.number → skipped with warn', async () => {
    const mem = makeMemFs();
    mem.setContent(
      JSON.stringify({
        gateId: 'g1',
        deliveryId: 'd1',
        scope: { owner: 'owner', repo: 'repo' },
        answer: 'x',
        answeredAt: '2027-01-14T12:00:00.000Z',
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

  it('scope.number as string → skipped with warn', async () => {
    const mem = makeMemFs();
    mem.setContent(
      JSON.stringify({
        gateId: 'g1',
        deliveryId: 'd1',
        scope: { owner: 'owner', repo: 'repo', number: '5' },
        answer: 'x',
        answeredAt: '2027-01-14T12:00:00.000Z',
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

  it('cross-epic line → dropped with logger.info naming gateId + scope + boundEpic', async () => {
    const mem = makeMemFs();
    mem.setContent(
      goodLine({ scope: { owner: 'other', repo: 'repo', number: 99 } }),
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
