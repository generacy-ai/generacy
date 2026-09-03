/**
 * Startup replay + cross-source interleave coverage for `AnswersFileSource`.
 * Uses the `fs` façade seam and `useFsWatch: false` so replay ordering is
 * deterministic without depending on real inotify timing.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AnswersFileSource,
  type FsFacade,
  type FsFileHandle,
  type FsStatResult,
} from '../answers-file-source.js';
import { EpicEventBus } from '../../mcp/event-bus.js';
import { EpicRefSetHolder } from '../ref-set-holder.js';
import type { GateAnswerEvent } from '../../watch/gate-answer.js';
import type { CockpitStreamEvent } from '../../watch/stream-event.js';
import type { GhWrapper, ResolvedEpic } from '@generacy-ai/cockpit';

const FILE_PATH = '/mem/answers.ndjson';
const PARENT_DIR = '/mem';

function makeFacade(content: string): FsFacade {
  const buf = Buffer.from(content, 'utf-8');
  return {
    stat: async (p: string): Promise<FsStatResult> => {
      if (p === PARENT_DIR) return { ino: 1, size: 4096 };
      if (p === FILE_PATH) return { ino: 2, size: buf.length };
      const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    },
    open: async (p: string): Promise<FsFileHandle> => {
      if (p !== FILE_PATH) {
        const err = new Error(`ENOENT ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
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
  };
}

// FROZEN down-path gate-answer line (Shape 3). Default gateKey issue-ref shares
// the bound epic owner/repo (owner/repo#5) so it passes the repo-scope filter.
function goodLine(gateId: string, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      type: 'gate-answer',
      gateId,
      gateKey: 'owner/repo#5:clarification:batch-abc',
      optionId: 'opt-1',
      freeText: null,
      actor: { userId: 'u1', email: 'op@example.com', displayName: 'Op' },
      answeredAt: '2027-01-14T12:00:00.000Z',
      deliveryId: `d-${gateId}`,
      ...extra,
    }) + '\n'
  );
}

function makeLogger(): { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), info: vi.fn() };
}

describe('AnswersFileSource — startup replay', () => {
  it('cap enforcement: 15 lines with cap=10 emits last 10 in order + one warn naming skipped range', async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 15; i++) lines.push(goodLine(`g${i}`));
    const content = lines.join('');
    const fs = makeFacade(content);

    const events: GateAnswerEvent[] = [];
    const logger = makeLogger();
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath: FILE_PATH,
      onEvent: async (e) => {
        events.push(e);
      },
      logger,
      useFsWatch: false,
      pollIntervalMs: 100,
      replayLineCap: 10,
      fs,
    });

    await src.start();
    await src.stop();

    expect(events.length).toBe(10);
    // Last 10 lines in order (g6..g15).
    expect(events.map((e) => e.gateId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `g${i + 6}`),
    );
    // Exactly one warn about cap.
    const capWarns = logger.warn.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('replay cap hit'));
    expect(capWarns).toHaveLength(1);
    // Skipped count matches; skippedFromByte=0 present.
    expect(capWarns[0]).toMatch(/skippedLines=5/);
    expect(capWarns[0]).toMatch(/skippedFromByte=0/);
    // skippedToByte should equal the byte offset where line g6 begins.
    const skippedBytes = Buffer.byteLength(lines.slice(0, 5).join(''), 'utf-8');
    expect(capWarns[0]).toMatch(new RegExp(`skippedToByte=${skippedBytes}`));
  });

  it('cap not hit: 3 lines with default cap emits all 3, no cap warn', async () => {
    const content =
      goodLine('g1') + goodLine('g2') + goodLine('g3');
    const fs = makeFacade(content);

    const events: GateAnswerEvent[] = [];
    const logger = makeLogger();
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath: FILE_PATH,
      onEvent: async (e) => {
        events.push(e);
      },
      logger,
      useFsWatch: false,
      pollIntervalMs: 100,
      fs,
    });

    await src.start();
    await src.stop();

    expect(events.map((e) => e.gateId)).toEqual(['g1', 'g2', 'g3']);
    const capWarns = logger.warn.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('replay cap hit'));
    expect(capWarns).toHaveLength(0);
  });

  it('replayLineCap: Infinity disables the cap — emits all lines', async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 30; i++) lines.push(goodLine(`g${i}`));
    const fs = makeFacade(lines.join(''));

    const events: GateAnswerEvent[] = [];
    const logger = makeLogger();
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath: FILE_PATH,
      onEvent: async (e) => {
        events.push(e);
      },
      logger,
      useFsWatch: false,
      pollIntervalMs: 100,
      replayLineCap: Infinity,
      fs,
    });

    await src.start();
    await src.stop();

    expect(events.length).toBe(30);
    const capWarns = logger.warn.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('replay cap hit'));
    expect(capWarns).toHaveLength(0);
  });

  it('mixed-case same-repo replay: 0 same-repo answers dropped for casing reasons', async () => {
    // Observed live pattern: one answers.ndjson carrying same-repo child-issue
    // answers whose gateKey owner/repo casing diverges from the bound epicRef.
    // Bound epic is painworth/doc-intel#3; every line is the same repo under a
    // different casing → all must emit, none dropped as cross-epic.
    const line = (gateId: string, gateKey: string): string =>
      JSON.stringify({
        type: 'gate-answer',
        gateId,
        gateKey,
        optionId: 'opt-1',
        freeText: null,
        actor: { userId: 'u1', email: 'op@example.com', displayName: 'Op' },
        answeredAt: '2027-01-14T12:00:00.000Z',
        deliveryId: `d-${gateId}`,
      }) + '\n';
    const content =
      line('m1', 'Painworth/doc-intel#23:clarification:batch-1') +
      line('m2', 'painworth/Doc-Intel#24:implementation-review:abc') +
      line('m3', 'PAINWORTH/DOC-INTEL#3:phase-queue:xyz');
    const fs = makeFacade(content);

    const events: GateAnswerEvent[] = [];
    const logger = makeLogger();
    const src = new AnswersFileSource({
      epicRef: 'painworth/doc-intel#3',
      filePath: FILE_PATH,
      onEvent: async (e) => {
        events.push(e);
      },
      logger,
      useFsWatch: false,
      pollIntervalMs: 100,
      fs,
    });

    await src.start();
    await src.stop();

    expect(events.map((e) => e.gateId)).toEqual(['m1', 'm2', 'm3']);
    const drops = logger.info.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('cross-epic drop'));
    expect(drops).toHaveLength(0);
  });

  it('replay ordering: pre-populated lines emit in file-append order', async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 5; i++) lines.push(goodLine(`g${i}`));
    const fs = makeFacade(lines.join(''));

    const events: GateAnswerEvent[] = [];
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath: FILE_PATH,
      onEvent: async (e) => {
        events.push(e);
      },
      logger: makeLogger(),
      useFsWatch: false,
      pollIntervalMs: 100,
      fs,
    });

    await src.start();
    await src.stop();

    expect(events.map((e) => e.gateId)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5']);
  });
});

describe('AnswersFileSource — replay recency window (US4)', () => {
  const NOW = Date.parse('2027-02-01T00:00:00.000Z');
  const OLD = '2027-01-01T00:00:00.000Z'; // > 24 h before NOW
  const RECENT = '2027-01-31T23:00:00.000Z'; // 1 h before NOW

  it('drops answers older than the 24 h window on byte-0 replay, logs info(window drop)', async () => {
    const content =
      goodLine('old', { answeredAt: OLD }) + goodLine('recent', { answeredAt: RECENT });
    const fs = makeFacade(content);
    const events: GateAnswerEvent[] = [];
    const logger = makeLogger();
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath: FILE_PATH,
      onEvent: async (e) => {
        events.push(e);
      },
      logger,
      useFsWatch: false,
      pollIntervalMs: 100,
      now: () => NOW,
      fs,
    });

    await src.start();
    await src.stop();

    expect(events.map((e) => e.gateId)).toEqual(['recent']);
    const windowDrops = logger.info.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('window drop'));
    expect(windowDrops).toHaveLength(1);
    expect(windowDrops[0]).toMatch(/gateId=old/);
    expect(windowDrops[0]).toMatch(/answeredAt=2027-01-01/);
  });

  it('a custom replayWindowMs widens the window (old line now emits)', async () => {
    const content = goodLine('old', { answeredAt: OLD });
    const fs = makeFacade(content);
    const events: GateAnswerEvent[] = [];
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath: FILE_PATH,
      onEvent: async (e) => {
        events.push(e);
      },
      logger: makeLogger(),
      useFsWatch: false,
      pollIntervalMs: 100,
      now: () => NOW,
      replayWindowMs: 90 * 86_400_000, // 90 days
      fs,
    });

    await src.start();
    await src.stop();

    expect(events.map((e) => e.gateId)).toEqual(['old']);
  });

  it('window is applied before the ref-set test — an out-of-window foreign line never triggers a miss refresh', async () => {
    const content = goodLine('old', {
      answeredAt: OLD,
      gateKey: 'owner/repo#999:clarification:x',
    });
    const fs = makeFacade(content);
    const resolve = vi.fn(
      async (): Promise<ResolvedEpic> => ({
        epic: { repo: 'owner/repo', number: 5 },
        parsed: { phases: [], adhocRefs: [], allRefs: [], warnings: [] },
        repos: ['owner/repo'],
        bodyHash: 'x',
      }),
    );
    const holder = new EpicRefSetHolder({
      epicRef: 'owner/repo#5',
      gh: {} as GhWrapper,
      logger: makeLogger(),
      resolve: resolve as never,
      now: () => 0,
    });
    await holder.refresh();
    resolve.mockClear();

    const events: GateAnswerEvent[] = [];
    const logger = makeLogger();
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath: FILE_PATH,
      onEvent: async (e) => {
        events.push(e);
      },
      logger,
      useFsWatch: false,
      pollIntervalMs: 100,
      now: () => NOW,
      refSetHolder: holder,
      fs,
    });

    await src.start();
    await src.stop();

    expect(events).toHaveLength(0);
    // Dropped by the window, not the scope test — no miss refresh fired.
    expect(resolve).not.toHaveBeenCalled();
    const windowDrops = logger.info.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('window drop'));
    expect(windowDrops).toHaveLength(1);
  });

  it('replay-line-cap backstop still applies alongside the window', async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 15; i++) lines.push(goodLine(`g${i}`, { answeredAt: RECENT }));
    const fs = makeFacade(lines.join(''));
    const events: GateAnswerEvent[] = [];
    const logger = makeLogger();
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath: FILE_PATH,
      onEvent: async (e) => {
        events.push(e);
      },
      logger,
      useFsWatch: false,
      pollIntervalMs: 100,
      replayLineCap: 10,
      now: () => NOW,
      fs,
    });

    await src.start();
    await src.stop();

    // All in-window, but the cap still trims to the last 10.
    expect(events.map((e) => e.gateId)).toEqual(
      Array.from({ length: 10 }, (_, i) => `g${i + 6}`),
    );
    const capWarns = logger.warn.mock.calls
      .map((c) => c[0] as string)
      .filter((m) => m.includes('replay cap hit'));
    expect(capWarns).toHaveLength(1);
  });
});

describe('AnswersFileSource — cross-source interleave', () => {
  it('smee-style emits interleave with tailer replay via shared bus (no drain barrier)', async () => {
    const tailerLines: string[] = [];
    for (let i = 1; i <= 3; i++) tailerLines.push(goodLine(`t${i}`));
    const fs = makeFacade(tailerLines.join(''));

    const bus = new EpicEventBus({ epic: 'owner/repo#5' });
    // Bridge: tailer emit → bus.emit (same wiring the doorbell uses).
    const tailerOnEvent = async (event: GateAnswerEvent): Promise<void> => {
      bus.emit(event);
    };

    // Fake smee source: emits issue-transition events interleaved with the
    // tailer's replay. We insert one smee emit before start(), one after.
    const smeeEvent = (n: number): CockpitStreamEvent => ({
      type: 'issue-transition',
      ts: '2027-01-14T12:00:00.000Z',
      repo: 'owner/repo',
      kind: 'issue',
      number: n,
      from: null,
      to: 'active',
      sourceLabel: 'phase:plan',
      url: `https://github.com/owner/repo/issues/${n}`,
      event: 'label-change',
      labels: ['phase:plan'],
    });

    // Pre-emit one smee event so the bus already has a non-tailer entry.
    bus.emit(smeeEvent(101));

    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath: FILE_PATH,
      onEvent: tailerOnEvent,
      logger: makeLogger(),
      useFsWatch: false,
      pollIntervalMs: 100,
      fs,
    });

    const startPromise = src.start();
    // Interleave another smee emit during (or immediately after) replay.
    bus.emit(smeeEvent(102));
    await startPromise;
    await src.stop();

    // Drain the bus.
    const result = await bus.waitFor({
      sinceCursor: 0,
      maxWaitMs: 100,
      coalesceWindowMs: 0,
      maxBatchSize: 100,
    });
    const types = result.entries.map((e) => e.event.type);
    // Both event types are present (interleave allowed).
    expect(types).toContain('issue-transition');
    expect(types).toContain('gate-answer');
    // Cursor monotonicity across all sources.
    const cursors = result.entries.map((e) => e.cursor);
    for (let i = 1; i < cursors.length; i++) {
      expect(cursors[i]).toBeGreaterThan(cursors[i - 1]!);
    }
    // Both smee events + all 3 tailer events land.
    const issueEvents = result.entries.filter((e) => e.event.type === 'issue-transition');
    const gateEvents = result.entries.filter((e) => e.event.type === 'gate-answer');
    expect(issueEvents).toHaveLength(2);
    expect(gateEvents).toHaveLength(3);
    // Tailer events appear in file order among themselves.
    expect(gateEvents.map((e) => (e.event as GateAnswerEvent).gateId)).toEqual([
      't1',
      't2',
      't3',
    ]);
  });
});
