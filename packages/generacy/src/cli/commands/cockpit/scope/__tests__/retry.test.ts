import { describe, expect, it } from 'vitest';
import type { GhWrapper, IssueRef } from '@generacy-ai/cockpit';
import { writeScopeWithRetry } from '../retry.js';
import { ScopeContendedError } from '../errors.js';

function makeGh(opts: {
  reads: string[]; // successive bodies returned from getIssue
  onWrite?: (body: string) => void;
  onWriteThrow?: (attempt: number) => boolean;
  onReadThrow?: (attempt: number) => Error | null;
}): GhWrapper & { readCount: number; writeCount: number; writes: string[] } {
  let readIdx = 0;
  const writes: string[] = [];
  const g = {
    readCount: 0,
    writeCount: 0,
    writes,
    async getIssue(_repo: string, _number: number) {
      const attempt = ++g.readCount;
      const err = opts.onReadThrow?.(attempt);
      if (err != null) throw err;
      const body = opts.reads[Math.min(readIdx, opts.reads.length - 1)]!;
      readIdx++;
      return {
        number: _number,
        title: 't',
        state: 'OPEN' as const,
        stateReason: null,
        labels: [],
        url: '',
        body,
        createdAt: '',
      };
    },
    async updateIssueBody(_repo: string, _number: number, body: string) {
      g.writeCount++;
      writes.push(body);
      opts.onWrite?.(body);
    },
  } as unknown as GhWrapper & { readCount: number; writeCount: number; writes: string[] };
  return g;
}

const scope: IssueRef = { repo: 'owner/scope', number: 42 };
const target: IssueRef = { repo: 'owner/target', number: 7 };

describe('writeScopeWithRetry', () => {
  it('single attempt succeeds — no sleep called', async () => {
    const written = '- [ ] owner/target#7\n';
    const gh = makeGh({ reads: ['', written] });
    const sleepCalls: number[] = [];
    const result = await writeScopeWithRetry({
      gh,
      scope,
      mutation: { kind: 'add', ref: target },
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(result.attempts).toBe(1);
    expect(result.noop).toBe(false);
    expect(sleepCalls).toEqual([]);
    expect(gh.writeCount).toBe(1);
  });

  it('ref already present — returns noop:true, attempts:1, no write called', async () => {
    const gh = makeGh({ reads: ['- [ ] owner/target#7\n'] });
    const result = await writeScopeWithRetry({
      gh,
      scope,
      mutation: { kind: 'add', ref: target },
    });
    expect(result.noop).toBe(true);
    expect(result.attempts).toBe(1);
    expect(gh.writeCount).toBe(0);
  });

  it('one race, resolves on retry 2 — sleep called once with 100ms', async () => {
    // Reads pattern:
    //   attempt 1: read '' -> write '- [ ] owner/target#7\n' -> readback returns other content (mismatch)
    //   attempt 2: read reveals someone else already added ours -> noop
    const reads = [
      '',
      '- [ ] someone/else#1\n', // verify readback mismatch
      '- [ ] owner/target#7\n', // attempt 2 read: already present → noop
    ];
    const gh = makeGh({ reads });
    const sleepCalls: number[] = [];
    const result = await writeScopeWithRetry({
      gh,
      scope,
      mutation: { kind: 'add', ref: target },
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(sleepCalls).toEqual([100]);
    expect(result.attempts).toBe(2);
    expect(result.noop).toBe(true);
  });

  it('persistent contention — throws ScopeContendedError after 5 attempts, sleeps 4x [100,250,500,1000]', async () => {
    // Every readback returns something that never matches what we just wrote.
    const reads = [
      '', '- [ ] other#1\n',
      '', '- [ ] other#2\n',
      '', '- [ ] other#3\n',
      '', '- [ ] other#4\n',
      '', '- [ ] other#5\n',
    ];
    const gh = makeGh({ reads });
    const sleepCalls: number[] = [];
    let error: unknown = null;
    try {
      await writeScopeWithRetry({
        gh,
        scope,
        mutation: { kind: 'add', ref: target },
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ScopeContendedError);
    expect((error as ScopeContendedError).code).toBe('SCOPE_ADD_CONTENDED');
    expect((error as ScopeContendedError).attempts).toBe(5);
    expect((error as ScopeContendedError).mutation).toBe('add');
    expect(sleepCalls).toEqual([100, 250, 500, 1000]);
    expect(gh.writeCount).toBe(5);
  });

  it('remove mutation raises SCOPE_ADD_CONTENDED with mutation:remove on exhaustion', async () => {
    // Body always claims the ref is present, but verify readback never matches.
    const reads = [
      '- [ ] owner/target#7\n', 'other content\n',
      '- [ ] owner/target#7\n', 'other content\n',
      '- [ ] owner/target#7\n', 'other content\n',
      '- [ ] owner/target#7\n', 'other content\n',
      '- [ ] owner/target#7\n', 'other content\n',
    ];
    const gh = makeGh({ reads });
    let error: unknown = null;
    try {
      await writeScopeWithRetry({
        gh,
        scope,
        mutation: { kind: 'remove', ref: target },
        sleep: async () => {},
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ScopeContendedError);
    expect((error as ScopeContendedError).code).toBe('SCOPE_ADD_CONTENDED');
    expect((error as ScopeContendedError).mutation).toBe('remove');
  });

  it('getIssue throws — error propagates without retry (I-4)', async () => {
    const gh = makeGh({
      reads: [''],
      onReadThrow: () => new Error('network down'),
    });
    let error: unknown = null;
    try {
      await writeScopeWithRetry({
        gh,
        scope,
        mutation: { kind: 'add', ref: target },
        sleep: async () => {},
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('network down');
    expect(gh.writeCount).toBe(0);
  });

  it('SC-005: 10 concurrent writers each add a distinct ref against a serialised body (converges w/ budget slack)', async () => {
    // Shared body under a synthetic gh that serialises writes (last-write-wins,
    // matching GitHub's PATCH semantics). Under microtask-FIFO scheduling this
    // converges 1 ref per round (see contracts/scope-retry.md). Default budget
    // of 5 admits only ~5 writers; use budget 15 to give 10-way convergence
    // slack while still verifying `attempts` stays bounded.
    let sharedBody = '';
    const gh: GhWrapper & { writes: number } = {
      writes: 0,
      async getIssue(_repo: string, number: number) {
        return {
          number,
          title: '',
          state: 'OPEN' as const,
          stateReason: null,
          labels: [],
          url: '',
          body: sharedBody,
          createdAt: '',
        };
      },
      async updateIssueBody(_repo: string, _number: number, body: string) {
        gh.writes++;
        sharedBody = body;
      },
    } as unknown as GhWrapper & { writes: number };

    const refs: IssueRef[] = Array.from({ length: 10 }, (_, i) => ({
      repo: 'owner/target',
      number: i + 1,
    }));

    const results = await Promise.all(
      refs.map((r) =>
        writeScopeWithRetry({
          gh,
          scope,
          mutation: { kind: 'add', ref: r },
          maxAttempts: 15,
          backoffMs: Array(15).fill(0),
          sleep: async () => {},
        }),
      ),
    );

    for (const r of results) {
      expect(r.attempts).toBeLessThanOrEqual(15);
    }
    for (const r of refs) {
      expect(sharedBody.includes(`- [ ] ${r.repo}#${r.number}`)).toBe(true);
    }
  });
});
