/**
 * Teardown coverage for `AnswersFileSource` with `useFsWatch: true` (the
 * production default). A Node `fsPromises.watch` async iterator never settles
 * its pending `next()` (nor `return()`) without a filesystem event, so before
 * the AbortSignal was wired into the watcher, `stop()` hung forever whenever the
 * parent dir existed and the watch loop had started — surfacing as a 10s test
 * timeout. This asserts `stop()` resolves promptly once the watcher is active.
 *
 * Uses a real temp dir so `fs.watch` behaves naturally (not environment- or
 * mock-dependent).
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  const dir = await mkdtemp(join(os.tmpdir(), 'answers-tailer-fswatch-'));
  created.push(dir);
  return dir;
}

function goodLine(): string {
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
    }) + '\n'
  );
}

async function waitFor<T>(
  fn: () => T | Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs = 2000,
  pollMs = 20,
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

describe('AnswersFileSource — fs.watch teardown', () => {
  it('stop() resolves promptly while the fs.watch loop is active', async () => {
    const root = await tempRoot();
    const parent = join(root, 'cockpit');
    const filePath = join(parent, 'answers.ndjson');
    await mkdir(parent, { recursive: true });
    await writeFile(filePath, goodLine());

    const events: GateAnswerEvent[] = [];
    const src = new AnswersFileSource({
      epicRef: 'owner/repo#5',
      filePath,
      onEvent: async (e) => {
        events.push(e);
      },
      logger: { warn: vi.fn(), info: vi.fn() },
      useFsWatch: true,
      // Large poll cadence so the fs.watch loop — not the poll timer — is the
      // live notification path when stop() fires.
      pollIntervalMs: 60_000,
    });

    await src.start();
    // Wait until the initial replay completes; by now startFsWatchLoop() has run
    // and the fs.watch async iterator is blocked on next().
    await waitFor(
      () => src.getState(),
      (s) => s === 'tailing',
    );

    // Pre-fix, stop() would hang here indefinitely (iter.return()/the loop's
    // pending next() never settle without an fs event). Race it against a
    // generous deadline that is still well under the 10s vitest timeout.
    const timedOut = Symbol('timed-out');
    const outcome = await Promise.race([
      src.stop().then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve(timedOut), 3000)),
    ]);

    expect(outcome).toBe('stopped');
    expect(src.getState()).toBe('stopped');
  });
});
