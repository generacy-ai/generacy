/**
 * Filesystem-level tail + rotation coverage for `AnswersFileSource`. Uses a
 * real temp dir (`node:fs/promises.mkdtemp`) so `fs.watch`, `stat`, rotation,
 * and truncation behave naturally.
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm, truncate, stat, rename } from 'node:fs/promises';
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
