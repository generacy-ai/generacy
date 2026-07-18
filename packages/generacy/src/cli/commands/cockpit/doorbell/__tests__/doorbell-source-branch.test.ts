/**
 * runDoorbell branch selection — asserts the branch chosen by
 * discoverChannelUrl determines whether `runPollMode` (acquireEpicBus) or
 * `runSmeeMode` (SmeeDoorbellSource) is used, and `armed\n` is written first.
 */
import { describe, expect, it, vi } from 'vitest';
import { runDoorbell } from '../../doorbell.js';

class MockStdout {
  chunks: string[] = [];
  write(chunk: string, cb?: () => void): boolean {
    this.chunks.push(chunk);
    if (cb) cb();
    return true;
  }
}

function makeFs(
  behavior: 'enoent' | 'valid' | 'malformed',
  matchPath?: string,
  value?: string,
) {
  return {
    readFile: async (path: string | Buffer | URL): Promise<string> => {
      // When matchPath is set, only that path exercises the behavior; every
      // other path (walk-up ancestors, absolute workspace mirror) returns
      // ENOENT — the walk-up chain terminates cleanly.
      if (matchPath != null && String(path) !== matchPath) {
        const err = new Error('not found') as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }
      if (behavior === 'enoent') {
        const err = new Error('not found') as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }
      if (behavior === 'malformed') return 'nonsense';
      return value ?? 'https://smee.io/abc123';
    },
  };
}

function mockAcquired(): { bus: any; release: () => void } {
  return {
    bus: {
      waitFor: async () =>
        new Promise(() => undefined), // never resolves
    },
    release: vi.fn(),
  };
}

describe('runDoorbell branch selection', () => {
  it('no channel file, no env override → poll-mode path taken; armed before selection', async () => {
    const stdout = new MockStdout();
    const acquireBus = vi.fn().mockResolvedValue(mockAcquired());
    const smeeFactory = vi.fn();

    const abort = new AbortController();
    // Abort immediately so runDoorbell doesn't block forever.
    setTimeout(() => abort.abort(), 20);

    const code = await runDoorbell(
      'o/r#100',
      {},
      {
        stdout,
        acquireBus,
        smeeSourceFactory: smeeFactory,
        env: {},
        fs: makeFs('enoent', '/tmp/nonexistent'),
        channelFilePath: '/tmp/nonexistent',
        exit: () => {
          /* do not throw */
        },
        abortSignal: abort.signal,
        logger: { warn: () => undefined },
      },
    );

    expect(code).toBe(0);
    // armed\n is the FIRST stdout write
    expect(stdout.chunks[0]).toBe('armed\n');
    // Poll-mode path was taken
    expect(acquireBus).toHaveBeenCalled();
    // Smee-mode was NOT taken
    expect(smeeFactory).not.toHaveBeenCalled();
  });

  it('env override with valid smee URL → smee-mode path taken', async () => {
    const stdout = new MockStdout();
    const acquireBus = vi.fn().mockResolvedValue(mockAcquired());
    const fakeSource = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const smeeFactory = vi.fn().mockReturnValue(fakeSource);

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 20);

    const code = await runDoorbell(
      'o/r#100',
      {},
      {
        stdout,
        acquireBus,
        smeeSourceFactory: smeeFactory,
        gh: {} as unknown as any,
        env: { COCKPIT_DOORBELL_SMEE_URL: 'https://smee.io/xyz' },
        fs: makeFs('enoent', '/tmp/nonexistent'),
        channelFilePath: '/tmp/nonexistent',
        exit: () => undefined,
        abortSignal: abort.signal,
        logger: { warn: () => undefined },
      },
    );

    expect(code).toBe(0);
    expect(stdout.chunks[0]).toBe('armed\n');
    expect(smeeFactory).toHaveBeenCalled();
    expect(acquireBus).not.toHaveBeenCalled();
  });

  it('malformed channel file → poll-mode path taken with malformed warn', async () => {
    const stdout = new MockStdout();
    const acquireBus = vi.fn().mockResolvedValue(mockAcquired());
    const smeeFactory = vi.fn();
    const warn = vi.fn();

    const abort = new AbortController();
    setTimeout(() => abort.abort(), 20);

    const code = await runDoorbell(
      'o/r#100',
      {},
      {
        stdout,
        acquireBus,
        smeeSourceFactory: smeeFactory,
        gh: {} as unknown as any,
        env: {},
        fs: makeFs('malformed', '/tmp/bogus'),
        channelFilePath: '/tmp/bogus',
        exit: () => undefined,
        abortSignal: abort.signal,
        logger: { warn },
      },
    );

    expect(code).toBe(0);
    expect(stdout.chunks[0]).toBe('armed\n');
    expect(acquireBus).toHaveBeenCalled();
    expect(smeeFactory).not.toHaveBeenCalled();
    // Two warns: the resolveWebhookTargets failure (stub gh has no getIssue)
    // and the malformed channel-file content.
    const messages = warn.mock.calls.map((c) => c[0] as string);
    expect(messages.some((m) => m.includes('webhook-target resolution failed'))).toBe(true);
    expect(messages.some((m) => m.includes('does not match smee URL pattern'))).toBe(true);
  });

  it('B1: gh runner returns smee /hooks → source=smee reason=startup-smee-selected (SC-001)', async () => {
    const stdout = new MockStdout();
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
      stderrChunks.push(s);
      return true;
    }) as typeof process.stderr.write;

    try {
      const smeeStart = vi.fn().mockResolvedValue(undefined);
      const smeeStop = vi.fn().mockResolvedValue(undefined);
      const smeeFactory = vi.fn().mockReturnValue({
        start: smeeStart,
        stop: smeeStop,
      });

      // Stub gh with a real-enough getIssue so resolveEpic succeeds and
      // resolveWebhookTargets yields the primary target.
      const gh = {
        async getIssue(_repo: string, _n: number) {
          return {
            number: 100,
            title: 't',
            state: 'OPEN' as const,
            stateReason: null,
            labels: [],
            url: '',
            body: '### Phase\n- [ ] o/r#101\n',
            createdAt: '',
          };
        },
      };

      // Runner stub: gh api /repos/o/r/hooks → single active smee hook.
      const runner = vi.fn().mockResolvedValue({
        stdout: JSON.stringify([
          {
            id: 1,
            active: true,
            config: { url: 'https://smee.io/branchtest' },
            updated_at: '2026-06-01T00:00:00Z',
          },
        ]),
        stderr: '',
        exitCode: 0,
      });

      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);

      // No env override, no walk-up hit, no absolute mirror hit, no channel file.
      const code = await runDoorbell(
        'o/r#100',
        {},
        {
          stdout,
          smeeSourceFactory: smeeFactory,
          gh: gh as unknown as any,
          runner,
          env: {},
          fs: makeFs('enoent', '/tmp/nonexistent'),
          channelFilePath: '/tmp/nonexistent',
          exit: () => undefined,
          abortSignal: abort.signal,
          logger: { warn: () => undefined },
        },
      );

      expect(code).toBe(0);
      expect(stdout.chunks[0]).toBe('armed\n');
      expect(smeeFactory).toHaveBeenCalledTimes(1);
      // gh api /hooks was called exactly once (primary target only).
      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner.mock.calls[0]![0]).toBe('gh');
      expect(runner.mock.calls[0]![1]).toEqual(['api', '/repos/o/r/hooks']);
      // Stderr contains the FR-006 line with the operator-visible smee label.
      const stderrText = stderrChunks.join('');
      expect(stderrText).toContain(
        'cockpit doorbell: source=smee reason=startup-smee-selected',
      );
    } finally {
      process.stderr.write = origWrite as typeof process.stderr.write;
    }
  });
});
