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

function makeFs(behavior: 'enoent' | 'valid' | 'malformed', value?: string) {
  return {
    readFile: async (): Promise<string> => {
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
        fs: makeFs('enoent'),
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
        fs: makeFs('enoent'),
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

  it('malformed channel file → poll-mode path taken with one warn', async () => {
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
        fs: makeFs('malformed'),
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
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
