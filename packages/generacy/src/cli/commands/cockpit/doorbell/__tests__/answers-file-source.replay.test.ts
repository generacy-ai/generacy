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
import type { GateAnswerEvent } from '../../watch/gate-answer.js';
import type { CockpitStreamEvent } from '../../watch/stream-event.js';

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

function goodLine(gateId: string, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      gateId,
      deliveryId: `d-${gateId}`,
      scope: { owner: 'owner', repo: 'repo', number: 5 },
      answer: {},
      answeredAt: '2027-01-14T12:00:00.000Z',
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
