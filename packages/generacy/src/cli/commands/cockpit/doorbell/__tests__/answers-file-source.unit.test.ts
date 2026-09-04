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
import { EpicRefSetHolder } from '../ref-set-holder.js';
import type { GhWrapper, ResolvedEpic } from '@generacy-ai/cockpit';

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

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
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

  it('forward case divergence (lowercase epic, mixed-case gateKey owner) → emitted, no drop', async () => {
    const mem = makeMemFs();
    // Bound epic owner is lowercase; the gateKey owner differs only by case.
    mem.setContent(
      goodLine({ gateKey: 'Painworth/x#1:clarification:batch-abc' }),
    );
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ epicRef: 'painworth/x#1', fs: mem.fs, onEvent, logger }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).toHaveBeenCalledTimes(1);
    const infoDrops = logger.info.mock.calls.filter((c) =>
      (c[0] as string).includes('cross-epic drop'),
    );
    expect(infoDrops).toHaveLength(0);
  });

  it('reverse case divergence (mixed-case epic, lowercase gateKey owner) → emitted', async () => {
    const mem = makeMemFs();
    mem.setContent(
      goodLine({ gateKey: 'painworth/x#1:clarification:batch-abc' }),
    );
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ epicRef: 'Painworth/x#1', fs: mem.fs, onEvent, logger }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).toHaveBeenCalledTimes(1);
    const infoDrops = logger.info.mock.calls.filter((c) =>
      (c[0] as string).includes('cross-epic drop'),
    );
    expect(infoDrops).toHaveLength(0);
  });

  it('repo-name case divergence → emitted (fold covers the repo component)', async () => {
    const mem = makeMemFs();
    mem.setContent(
      goodLine({ gateKey: 'owner/repo#1:clarification:batch-abc' }),
    );
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ epicRef: 'owner/Repo#1', fs: mem.fs, onEvent, logger }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).toHaveBeenCalledTimes(1);
    const infoDrops = logger.info.mock.calls.filter((c) =>
      (c[0] as string).includes('cross-epic drop'),
    );
    expect(infoDrops).toHaveLength(0);
  });

  it('genuine foreign repo (differs beyond casing) → still dropped + logged', async () => {
    const mem = makeMemFs();
    mem.setContent(
      goodLine({ gateKey: 'painworth/y#1:clarification:batch-abc' }),
    );
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ epicRef: 'painworth/x#1', fs: mem.fs, onEvent, logger }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).not.toHaveBeenCalled();
    const infoDrops = logger.info.mock.calls.filter((c) =>
      (c[0] as string).includes('cross-epic drop'),
    );
    expect(infoDrops).toHaveLength(1);
  });

  it('foreign owner (differs beyond casing) → still dropped', async () => {
    const mem = makeMemFs();
    mem.setContent(
      goodLine({ gateKey: 'other/x#1:clarification:batch-abc' }),
    );
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ epicRef: 'painworth/x#1', fs: mem.fs, onEvent, logger }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).not.toHaveBeenCalled();
    const infoDrops = logger.info.mock.calls.filter((c) =>
      (c[0] as string).includes('cross-epic drop'),
    );
    expect(infoDrops).toHaveLength(1);
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

/**
 * Ref-set-scoped filtering (FR-001..003). With an `EpicRefSetHolder`, scoping
 * is membership in the resolved ref set — same-repo answers whose issue is NOT
 * in the tree are dropped, and cross-repo children that ARE in the tree emit
 * (the #1111 regression). Without a holder the legacy owner/repo compare above
 * still applies.
 */
function resolvedWith(
  epicRepo: string,
  epicNumber: number,
  childRefs: Array<{ repo: string; number: number }>,
): ResolvedEpic {
  return {
    epic: { repo: epicRepo, number: epicNumber },
    parsed: { phases: [], adhocRefs: [], allRefs: childRefs, warnings: [] },
    repos: Array.from(new Set([epicRepo, ...childRefs.map((r) => r.repo)])).sort(),
    bodyHash: 'x',
  };
}

function makeHolder(
  resolveImpl: () => Promise<ResolvedEpic>,
): { holder: EpicRefSetHolder; resolve: ReturnType<typeof vi.fn> } {
  const resolve = vi.fn(resolveImpl);
  const holder = new EpicRefSetHolder({
    epicRef: 'owner/repo#5',
    gh: {} as GhWrapper,
    logger: makeLogger(),
    resolve: resolve as never,
    now: () => 0,
  });
  return { holder, resolve };
}

describe('AnswersFileSource — ref-set scoping (with holder)', () => {
  it('same-repo answer whose issue is NOT in the ref set is dropped + info(gateId)', async () => {
    const mem = makeMemFs();
    mem.setContent(goodLine({ gateKey: 'owner/repo#99:clarification:x' }));
    const { holder } = makeHolder(async () =>
      resolvedWith('owner/repo', 5, [{ repo: 'owner/repo', number: 42 }]),
    );
    await holder.refresh();

    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, logger, refSetHolder: holder }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).not.toHaveBeenCalled();
    const drop = logger.info.mock.calls
      .map((c) => c[0] as string)
      .find((m) => m.includes('cross-epic drop'));
    expect(drop).toBeDefined();
    expect(drop).toMatch(/gateId=g1/);
    expect(drop).toMatch(/scope=owner\/repo#99/);
    expect(drop).toMatch(/boundEpic=owner\/repo#5/);
  });

  it('cross-repo in-scope child is emitted (#1111 regression)', async () => {
    const mem = makeMemFs();
    mem.setContent(goodLine({ gateKey: 'other/child#7:implementation-review:z' }));
    const { holder } = makeHolder(async () =>
      resolvedWith('owner/repo', 5, [{ repo: 'other/child', number: 7 }]),
    );
    await holder.refresh();

    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, logger, refSetHolder: holder }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).toHaveBeenCalledTimes(1);
    const drops = logger.info.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('cross-epic drop'));
    expect(drops).toHaveLength(0);
  });

  it('unknown ref triggers refreshOnMiss(); a late-created child emits after refresh', async () => {
    const mem = makeMemFs();
    mem.setContent(goodLine({ gateKey: 'owner/repo#42:clarification:x' }));
    // Holder never pre-resolved: current is null, so the first membership check
    // misses and the tailer calls refreshOnMiss(), which resolves the tree that
    // now contains the late-created child.
    const { holder, resolve } = makeHolder(async () =>
      resolvedWith('owner/repo', 5, [{ repo: 'owner/repo', number: 42 }]),
    );

    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, refSetHolder: holder }),
    );
    await src.start();
    await src.stop();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('non-issue gateKey target still emits even with a holder', async () => {
    const mem = makeMemFs();
    mem.setContent(goodLine({ gateKey: 'tracking-thread-7:filing:draft-9' }));
    const { holder, resolve } = makeHolder(async () =>
      resolvedWith('owner/repo', 5, []),
    );
    await holder.refresh();

    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, refSetHolder: holder }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).toHaveBeenCalledTimes(1);
    // Non-issue target bypasses scoping — no miss refresh beyond the pre-resolve.
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('scope oracle that has NEVER resolved fails OPEN — the bound epic\'s own answer still emits', async () => {
    // Regression: `holder.current` is null after a startup resolve failure
    // (GitHub 403 / rate limit is routine on a shared account). The membership
    // test `holder.current?.issues.has(key) ?? false` is then false for EVERY
    // answer — including the bound epic's own — so all of them were dropped as
    // "cross-epic" while the cursor advanced past them: permanent, silent loss.
    const mem = makeMemFs();
    mem.setContent(goodLine({ gateKey: 'owner/repo#5:clarification:x' }));
    const { holder, resolve } = makeHolder(async () => {
      throw new Error('HTTP 403: API rate limit exceeded');
    });
    // Startup resolve fails; the holder has no set at all.
    await expect(holder.refresh()).rejects.toThrow(/rate limit/);
    expect(holder.current).toBeNull();

    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, logger, refSetHolder: holder }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalled();
    const warn = logger.warn.mock.calls
      .map((c) => c[0] as string)
      .find((m) => m.includes('scope oracle unresolved'));
    expect(warn).toBeDefined();
    expect(warn).toMatch(/gateId=g1/);
    // Never silently dropped.
    expect(
      logger.info.mock.calls
        .map((c) => c[0] as string)
        .some((m) => m.includes('cross-epic drop')),
    ).toBe(false);
  });

  it('fail-open still drops a genuinely foreign repo (degrades to owner/repo, not to "emit everything")', async () => {
    const mem = makeMemFs();
    mem.setContent(goodLine({ gateKey: 'other/elsewhere#7:clarification:x' }));
    const { holder } = makeHolder(async () => {
      throw new Error('HTTP 403: API rate limit exceeded');
    });
    await expect(holder.refresh()).rejects.toThrow();

    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, logger, refSetHolder: holder }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).not.toHaveBeenCalled();
    expect(
      logger.info.mock.calls
        .map((c) => c[0] as string)
        .some((m) => m.includes('cross-epic drop')),
    ).toBe(true);
  });

  it('a miss inside a throttle window armed by a FAILED resolve defers instead of dropping', async () => {
    // FR-002: drop only if still foreign AFTER a re-resolve. When the throttle
    // window was armed by a resolve that threw, no authoritative re-resolve has
    // happened — dropping there is permanent loss of a late-created child.
    let clock = 0;
    let known: Array<{ repo: string; number: number }> = [];
    let failNext = true;
    const resolve = vi.fn(async () => {
      if (failNext) throw new Error('HTTP 403: API rate limit exceeded');
      return resolvedWith('owner/repo', 5, known);
    });
    const holder = new EpicRefSetHolder({
      epicRef: 'owner/repo#5',
      gh: {} as GhWrapper,
      logger: makeLogger(),
      resolve: resolve as never,
      missRefreshMinIntervalMs: 30_000,
      now: () => clock,
    });
    // One successful resolve so the holder HAS a set (so this exercises the
    // throttled-stale path, not the fail-open path)…
    failNext = false;
    await holder.refresh();
    expect(holder.current).not.toBeNull();
    // …then a failing miss-refresh arms the throttle window with a stale set.
    failNext = true;
    clock += 60_000;
    expect(await holder.refreshOnMiss()).toBe('failed');

    const mem = makeMemFs();
    mem.setContent(goodLine({ gateKey: 'owner/repo#99:clarification:x' }));
    const logger = makeLogger();
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent, logger, refSetHolder: holder }),
    );
    await src.start();

    // Deferred: neither emitted nor dropped while the stale throttle holds.
    expect(onEvent).not.toHaveBeenCalled();
    expect(
      logger.info.mock.calls
        .map((c) => c[0] as string)
        .some((m) => m.includes('cross-epic drop')),
    ).toBe(false);
    expect(
      logger.info.mock.calls
        .map((c) => c[0] as string)
        .some((m) => m.includes('scope miss deferred')),
    ).toBe(true);

    // Once the window expires and the ref set resolves with the late-created
    // child, the retained line emits rather than having been lost.
    clock += 60_000;
    failNext = false;
    known = [{ repo: 'owner/repo', number: 99 }];
    await waitForCondition(() => onEvent.mock.calls.length > 0, 2000);
    await src.stop();
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('no-holder (harness) mode keeps the legacy same-repo emit', async () => {
    const mem = makeMemFs();
    // Same repo, issue not in any tree — legacy compare emits (repo matches).
    mem.setContent(goodLine({ gateKey: 'owner/repo#99:clarification:x' }));
    const onEvent = vi.fn();
    const src = new AnswersFileSource(
      baseOptions({ fs: mem.fs, onEvent }),
    );
    await src.start();
    await src.stop();

    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});
