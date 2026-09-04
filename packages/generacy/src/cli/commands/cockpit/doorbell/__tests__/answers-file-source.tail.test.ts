/**
 * Filesystem-level tail + rotation coverage for `AnswersFileSource`. Uses a
 * real temp dir (`node:fs/promises.mkdtemp`) so `fs.watch`, `stat`, rotation,
 * and truncation behave naturally.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm, truncate, stat, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { AnswersFileSource } from '../answers-file-source.js';
import type { GateAnswerEvent } from '../../watch/gate-answer.js';

const created: string[] = [];

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop()!;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(os.tmpdir(), 'answers-tailer-tail-'));
  created.push(dir);
  return dir;
}

function makeLogger(): { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), info: vi.fn() };
}

// FROZEN down-path gate-answer line (Shape 3). Default gateKey issue-ref shares
// the bound epic owner/repo (owner/repo#5) so it passes the repo-scope filter.
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

async function waitFor<T>(
  fn: () => T | Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs: number = 2000,
  pollMs: number = 20,
): Promise<T> {
  const started = Date.now();
  let last: T = await fn();
  while (!predicate(last)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms; last=${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
    last = await fn();
  }
  return last;
}

describe('AnswersFileSource — dir-then-file appearance', () => {
  it('transitions waiting-for-dir → waiting-for-file → tailing and emits initial line', async () => {
    const root = await tempRoot();
    const parent = join(root, 'cockpit');
    const filePath = join(parent, 'answers.ndjson');

    const events: GateAnswerEvent[] = [];
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath,
      onEvent: async (e) => {
        events.push(e);
      },
      logger: makeLogger(),
      useFsWatch: false,
      pollIntervalMs: 100,
    });

    await src.start();
    try {
      expect(src.getState()).toBe('waiting-for-dir');

      await mkdir(parent, { recursive: true });
      await waitFor(
        () => src.getState(),
        (s) => s === 'waiting-for-file',
      );

      await writeFile(filePath, goodLine());
      await waitFor(
        () => src.getState(),
        (s) => s === 'tailing',
      );
      await waitFor(
        () => events.length,
        (n) => n >= 1,
      );

      expect(events).toHaveLength(1);
      expect(events[0]!.gateId).toBe('g1');
    } finally {
      await src.stop();
    }
  });
});

describe('AnswersFileSource — live append', () => {
  it('emits one event per appended line, in file-append order', async () => {
    const root = await tempRoot();
    const parent = join(root, 'cockpit');
    const filePath = join(parent, 'answers.ndjson');
    await mkdir(parent, { recursive: true });
    await writeFile(filePath, goodLine({ gateId: 'g1', deliveryId: 'd1' }));

    const events: GateAnswerEvent[] = [];
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath,
      onEvent: async (e) => {
        events.push(e);
      },
      logger: makeLogger(),
      useFsWatch: false,
      pollIntervalMs: 100,
    });

    await src.start();
    try {
      await waitFor(
        () => events.length,
        (n) => n >= 1,
      );

      await appendFile(filePath, goodLine({ gateId: 'g2', deliveryId: 'd2' }));
      await waitFor(
        () => events.length,
        (n) => n >= 2,
      );

      await appendFile(filePath, goodLine({ gateId: 'g3', deliveryId: 'd3' }));
      await waitFor(
        () => events.length,
        (n) => n >= 3,
      );

      expect(events.map((e) => e.gateId)).toEqual(['g1', 'g2', 'g3']);
    } finally {
      await src.stop();
    }
  });
});

describe('AnswersFileSource — rotation', () => {
  it('detects inode change and re-enters replaying, emits new line, logs rotation info', async () => {
    const root = await tempRoot();
    const parent = join(root, 'cockpit');
    const filePath = join(parent, 'answers.ndjson');
    await mkdir(parent, { recursive: true });
    await writeFile(filePath, goodLine({ gateId: 'g-before' }));

    const events: GateAnswerEvent[] = [];
    const logger = makeLogger();
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath,
      onEvent: async (e) => {
        events.push(e);
      },
      logger,
      useFsWatch: false,
      pollIntervalMs: 100,
    });

    await src.start();
    try {
      await waitFor(
        () => events.length,
        (n) => n >= 1,
      );

      const oldStat = await stat(filePath);
      // Simulate a logrotate-style rotation: create a fresh file elsewhere,
      // then atomically rename over the original. Guarantees a new inode.
      const tmpPath = join(parent, 'answers.ndjson.new');
      await writeFile(tmpPath, goodLine({ gateId: 'g-after' }));
      await rename(tmpPath, filePath);
      const newStat = await stat(filePath);
      expect(Number(newStat.ino)).not.toBe(Number(oldStat.ino));

      await waitFor(
        () => events.length,
        (n) => n >= 2,
      );
      expect(events.map((e) => e.gateId)).toEqual(['g-before', 'g-after']);

      const infoMsgs = (logger.info.mock.calls as Array<[string]>).map((c) => c[0]);
      const rotation = infoMsgs.find((m) => m.includes('rotation'));
      expect(rotation).toBeDefined();
      expect(rotation).toMatch(new RegExp(`oldIno=${Number(oldStat.ino)}`));
      expect(rotation).toMatch(new RegExp(`newIno=${Number(newStat.ino)}`));
    } finally {
      await src.stop();
    }
  });
});

describe('AnswersFileSource — truncation', () => {
  it('detects size shrink (same inode), re-enters replaying, logs truncation info', async () => {
    const root = await tempRoot();
    const parent = join(root, 'cockpit');
    const filePath = join(parent, 'answers.ndjson');
    await mkdir(parent, { recursive: true });
    await writeFile(
      filePath,
      goodLine({ gateId: 'g1' }) + goodLine({ gateId: 'g2', deliveryId: 'd2' }),
    );

    const events: GateAnswerEvent[] = [];
    const logger = makeLogger();
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath,
      onEvent: async (e) => {
        events.push(e);
      },
      logger,
      useFsWatch: false,
      pollIntervalMs: 100,
    });

    await src.start();
    try {
      await waitFor(
        () => events.length,
        (n) => n >= 2,
      );

      const beforeIno = (await stat(filePath)).ino;
      await truncate(filePath, 0);
      await writeFile(
        filePath,
        goodLine({ gateId: 'g-post-truncate', deliveryId: 'd-post' }),
      );
      // Verify inode unchanged.
      const afterIno = (await stat(filePath)).ino;
      expect(afterIno).toBe(beforeIno);

      await waitFor(
        () => events.length,
        (n) => n >= 3,
      );
      expect(events.map((e) => e.gateId)).toEqual([
        'g1',
        'g2',
        'g-post-truncate',
      ]);

      const infoMsgs = (logger.info.mock.calls as Array<[string]>).map((c) => c[0]);
      const truncMsg = infoMsgs.find((m) => m.includes('truncation'));
      expect(truncMsg).toBeDefined();
      expect(truncMsg).toMatch(new RegExp(`ino=${Number(beforeIno)}`));
    } finally {
      await src.stop();
    }
  });
});

/** Path of the persisted cursor for the bound epic beside the answers file. */
const cursorPath = (parent: string): string =>
  join(parent, 'cursors', 'owner__repo__5.json');

describe('AnswersFileSource — persisted cursor resume (US1)', () => {
  async function makeSrc(
    filePath: string,
    events: GateAnswerEvent[],
  ): Promise<AnswersFileSource> {
    return new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath,
      onEvent: async (e) => {
        events.push(e);
      },
      logger: makeLogger(),
      useFsWatch: false,
      pollIntervalMs: 100,
    });
  }

  it('a restart with a fully-consumed cursor emits zero events; a later append emits only the new line', async () => {
    const root = await tempRoot();
    const parent = join(root, 'cockpit');
    const filePath = join(parent, 'answers.ndjson');
    await mkdir(parent, { recursive: true });
    await writeFile(
      filePath,
      goodLine({ gateId: 'g1' }) + goodLine({ gateId: 'g2', deliveryId: 'd2' }),
    );

    // First run consumes both lines and persists the cursor on stop().
    const firstEvents: GateAnswerEvent[] = [];
    const first = await makeSrc(filePath, firstEvents);
    await first.start();
    await waitFor(() => firstEvents.length, (n) => n >= 2);
    await first.stop();

    // The cursor now points at the end of the file.
    const persisted = JSON.parse(await readFile(cursorPath(parent), 'utf-8'));
    const fileSize = (await stat(filePath)).size;
    expect(persisted.offset).toBe(fileSize);
    expect(persisted.ino).toBe(Number((await stat(filePath)).ino));

    // Second run resumes from the cursor: no replay, zero events.
    const secondEvents: GateAnswerEvent[] = [];
    const second = await makeSrc(filePath, secondEvents);
    await second.start();
    try {
      expect(second.getState()).toBe('tailing');
      await new Promise((r) => setTimeout(r, 250));
      expect(secondEvents).toHaveLength(0);

      // Only bytes past the cursor are tailed.
      await appendFile(filePath, goodLine({ gateId: 'g3', deliveryId: 'd3' }));
      await waitFor(() => secondEvents.length, (n) => n >= 1);
      expect(secondEvents.map((e) => e.gateId)).toEqual(['g3']);
    } finally {
      await second.stop();
    }
  });

  it('rotation (new inode) after a resume re-enters replay and rewrites the cursor for the new inode', async () => {
    const root = await tempRoot();
    const parent = join(root, 'cockpit');
    const filePath = join(parent, 'answers.ndjson');
    await mkdir(parent, { recursive: true });
    await writeFile(filePath, goodLine({ gateId: 'g1' }));

    const firstEvents: GateAnswerEvent[] = [];
    const first = await makeSrc(filePath, firstEvents);
    await first.start();
    await waitFor(() => firstEvents.length, (n) => n >= 1);
    await first.stop();
    const oldIno = Number((await stat(filePath)).ino);

    // Restart, then rotate the file (fresh inode via rename-over).
    const events: GateAnswerEvent[] = [];
    const src = await makeSrc(filePath, events);
    await src.start();
    try {
      // Resume → no replay of g1.
      await new Promise((r) => setTimeout(r, 200));
      expect(events).toHaveLength(0);

      const tmpPath = join(parent, 'answers.ndjson.new');
      await writeFile(tmpPath, goodLine({ gateId: 'g-after' }));
      await rename(tmpPath, filePath);
      const newIno = Number((await stat(filePath)).ino);
      expect(newIno).not.toBe(oldIno);

      await waitFor(() => events.length, (n) => n >= 1);
      expect(events.map((e) => e.gateId)).toEqual(['g-after']);

      // Cursor rewritten for the new inode.
      await waitFor(
        async () => {
          try {
            return JSON.parse(await readFile(cursorPath(parent), 'utf-8')).ino as number;
          } catch {
            return -1;
          }
        },
        (ino) => ino === newIno,
      );
    } finally {
      await src.stop();
    }
  });
  it('in-place truncation with a live cursor rewrites the cursor DOWN and converges', async () => {
    // Regression (#1228 review): `advance()` is monotonic within an inode, but
    // an in-place `truncate -s 0` keeps the SAME inode. Without an explicit
    // reset at replay, every advance below the pre-truncation high-water mark
    // is swallowed, `flush()` rewrites the stale (too-high) offset over a tiny
    // file, and the NEXT start takes the resume branch and skips every answer
    // under that byte — permanently, with no convergence.
    // `contracts/answers-cursor-store.md` requires the `offset > size` row to
    // rewrite the cursor; this pins that.
    const root = await tempRoot();
    const parent = join(root, 'cockpit');
    const filePath = join(parent, 'answers.ndjson');
    await mkdir(parent, { recursive: true });

    // Run 1 — consume a backlog of 4 lines, persist a high cursor offset.
    let content = '';
    for (let i = 1; i <= 4; i++) {
      content += goodLine({ gateId: `g${i}`, deliveryId: `d${i}` });
    }
    await writeFile(filePath, content);
    const firstEvents: GateAnswerEvent[] = [];
    const first = await makeSrc(filePath, firstEvents);
    await first.start();
    await waitFor(() => firstEvents.length, (n) => n >= 4);
    await first.stop();

    const bigOffset = (await stat(filePath)).size;
    const ino = Number((await stat(filePath)).ino);
    expect(
      JSON.parse(await readFile(cursorPath(parent), 'utf-8')).offset,
    ).toBe(bigOffset);

    // Truncate IN PLACE (inode preserved) and write one short line back.
    await truncate(filePath, 0);
    await writeFile(filePath, goodLine({ gateId: 'g-t1', deliveryId: 'd-t1' }));
    const smallSize = (await stat(filePath)).size;
    expect(Number((await stat(filePath)).ino)).toBe(ino);
    expect(smallSize).toBeLessThan(bigOffset);

    // Run 2 — cursor.offset > size ⇒ replay; the persisted cursor must be
    // REWRITTEN down to the truncated file's end, not left at bigOffset.
    const secondEvents: GateAnswerEvent[] = [];
    const second = await makeSrc(filePath, secondEvents);
    await second.start();
    await waitFor(() => secondEvents.length, (n) => n >= 1);
    await second.stop();
    expect(secondEvents.map((e) => e.gateId)).toEqual(['g-t1']);
    const rewritten = JSON.parse(await readFile(cursorPath(parent), 'utf-8'));
    expect(rewritten.ino).toBe(ino);
    expect(rewritten.offset).toBe(smallSize);

    // Run 3 — the file grows back past the OLD offset. With a stale cursor the
    // resume branch would silently skip everything under bigOffset; with the
    // rewritten cursor every appended answer surfaces exactly once.
    let appended = '';
    for (let i = 2; i <= 12; i++) {
      appended += goodLine({ gateId: `g-t${i}`, deliveryId: `d-t${i}` });
    }
    await appendFile(filePath, appended);
    expect((await stat(filePath)).size).toBeGreaterThan(bigOffset);

    const thirdEvents: GateAnswerEvent[] = [];
    const third = await makeSrc(filePath, thirdEvents);
    await third.start();
    try {
      await waitFor(() => thirdEvents.length, (n) => n >= 11);
      expect(thirdEvents.map((e) => e.gateId)).toEqual(
        Array.from({ length: 11 }, (_, i) => `g-t${i + 2}`),
      );
    } finally {
      await third.stop();
    }
  });
});

describe('AnswersFileSource — emit failures do not consume the line', () => {
  it('a rejecting onEvent sink leaves the cursor short of the line and re-delivers it', async () => {
    // FR-004: the cursor advances ON EMIT. A sink rejection previously still
    // advanced it, silently losing that one answer forever.
    const root = await tempRoot();
    const parent = join(root, 'cockpit');
    const filePath = join(parent, 'answers.ndjson');
    await mkdir(parent, { recursive: true });
    await writeFile(filePath, goodLine({ gateId: 'g1', deliveryId: 'd1' }));

    const delivered: GateAnswerEvent[] = [];
    let rejectCount = 2;
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath,
      onEvent: async (e) => {
        if (rejectCount > 0) {
          rejectCount--;
          throw new Error('sink is wedged');
        }
        delivered.push(e);
      },
      logger: makeLogger(),
      useFsWatch: false,
      pollIntervalMs: 100,
    });

    await src.start();
    try {
      await waitFor(() => delivered.length, (n) => n >= 1, 3000);
      expect(delivered.map((e) => e.gateId)).toEqual(['g1']);
    } finally {
      await src.stop();
    }

    // Only the successful emit moved the cursor.
    const persisted = JSON.parse(await readFile(cursorPath(parent), 'utf-8'));
    expect(persisted.offset).toBe((await stat(filePath)).size);
  });
});

describe('AnswersFileSource — stop() semantics', () => {
  it('stop() while tailing: no emit-after-stop; second stop() is a no-op', async () => {
    const root = await tempRoot();
    const parent = join(root, 'cockpit');
    const filePath = join(parent, 'answers.ndjson');
    await mkdir(parent, { recursive: true });
    await writeFile(filePath, goodLine({ gateId: 'g1' }));

    const events: GateAnswerEvent[] = [];
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath,
      onEvent: async (e) => {
        events.push(e);
      },
      logger: makeLogger(),
      useFsWatch: false,
      pollIntervalMs: 100,
    });

    await src.start();
    await waitFor(
      () => events.length,
      (n) => n >= 1,
    );
    await src.stop();
    expect(src.getState()).toBe('stopped');

    const priorCount = events.length;
    // Append after stop — must not emit.
    await appendFile(filePath, goodLine({ gateId: 'g-after-stop', deliveryId: 'd-after' }));
    await new Promise((r) => setTimeout(r, 300));
    expect(events.length).toBe(priorCount);

    // Second stop() is a no-op.
    await src.stop();
    expect(src.getState()).toBe('stopped');
  });
});
