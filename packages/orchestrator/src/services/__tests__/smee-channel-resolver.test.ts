import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname as dirnameFn } from 'node:path';
import { SmeeChannelResolver, SMEE_URL_PATTERN } from '../smee-channel-resolver.js';

/**
 * Helper: redirect Response with optional Location header.
 */
function makeRedirect(status: number, location: string | null): Response {
  const headers = new Headers();
  if (location !== null) {
    headers.set('location', location);
  }
  return new Response(null, { status, headers });
}

/**
 * Helper: 302 Response with Location header (thin wrapper preserved for
 * existing call-sites).
 */
function make302(location: string | null): Response {
  return makeRedirect(302, location);
}

describe('SmeeChannelResolver', () => {
  let baseDir: string;
  let channelFilePath: string;
  let mockLogger: {
    info: Mock;
    warn: Mock;
    error: Mock;
  };

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'smee-resolver-'));
    channelFilePath = join(baseDir, 'smee-channel');
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  });

  afterEach(() => {
    try {
      // Clean up: chmod anything that might be locked, then rm -rf
      chmodSync(baseDir, 0o700);
    } catch {
      // ignore
    }
    rmSync(baseDir, { recursive: true, force: true });
  });

  describe('SMEE_URL_PATTERN', () => {
    it('accepts smee.io URLs with alphanumeric + _- characters', () => {
      expect(SMEE_URL_PATTERN.test('https://smee.io/mNhnxyK56d9qkZo')).toBe(true);
      expect(SMEE_URL_PATTERN.test('https://smee.io/abc_def-123')).toBe(true);
    });

    it('rejects non-smee URLs and malformed shapes', () => {
      expect(SMEE_URL_PATTERN.test('https://evil.com/x')).toBe(false);
      expect(SMEE_URL_PATTERN.test('http://smee.io/abc')).toBe(false);
      expect(SMEE_URL_PATTERN.test('https://smee.io/')).toBe(false);
      expect(SMEE_URL_PATTERN.test('https://smee.io/abc?q=1')).toBe(false);
      expect(SMEE_URL_PATTERN.test('https://smee.io/abc/def')).toBe(false);
    });
  });

  it('T1: presetUrl short-circuits — no file read, no fetch', async () => {
    const fetchMock = vi.fn();
    const preset = 'https://smee.io/preset123';

    // Write a file that would otherwise be picked up at tier 2
    writeFileSync(channelFilePath, 'https://smee.io/persistedXYZ');

    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      presetUrl: preset,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await resolver.resolve();

    expect(result).toEqual({ channelUrl: preset, source: 'env-or-yaml' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('T2: valid persisted file returns source: persisted (no fetch, no write)', async () => {
    const persistedUrl = 'https://smee.io/persistedABC';
    writeFileSync(channelFilePath, persistedUrl);
    const originalMtime = statSync(channelFilePath).mtimeMs;

    const fetchMock = vi.fn();
    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await resolver.resolve();

    expect(result).toEqual({ channelUrl: persistedUrl, source: 'persisted' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      { channelUrl: persistedUrl, source: 'persisted' },
      'Reusing persisted smee channel URL',
    );
    // File was not overwritten
    expect(statSync(channelFilePath).mtimeMs).toBe(originalMtime);
  });

  it('T3: malformed persisted file → L3 log + fetch + overwrite', async () => {
    const provisionedUrl = 'https://smee.io/newXYZ';
    const malformed = 'this is not a valid smee url ' + 'x'.repeat(200);
    writeFileSync(channelFilePath, malformed);

    const fetchMock = vi.fn().mockResolvedValue(make302(provisionedUrl));
    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await resolver.resolve();

    expect(result).toEqual({ channelUrl: provisionedUrl, source: 'provisioned' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // L3 warn with truncated contentPreview
    const warnCall = mockLogger.warn.mock.calls.find(
      (c) => c[1] === 'Persisted smee channel file has malformed content — re-provisioning',
    );
    expect(warnCall).toBeDefined();
    const [ctx] = warnCall as [Record<string, unknown>, string];
    expect(ctx.path).toBe(channelFilePath);
    expect((ctx.contentPreview as string).length).toBeLessThanOrEqual(64);
    // File overwritten with provisioned URL
    expect(readFileSync(channelFilePath, 'utf-8')).toBe(provisionedUrl);
  });

  it('T4: ENOENT → silent fall-through to tier 3', async () => {
    const provisionedUrl = 'https://smee.io/newFRESH';
    // No file created
    const fetchMock = vi.fn().mockResolvedValue(make302(provisionedUrl));
    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await resolver.resolve();

    expect(result).toEqual({ channelUrl: provisionedUrl, source: 'provisioned' });
    // No warn for ENOENT
    const enoentWarn = mockLogger.warn.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('Failed to read persisted'),
    );
    expect(enoentWarn).toBeUndefined();
  });

  it('T5: EACCES → warn, fall through to tier 3', async () => {
    // Create a subdirectory whose file cannot be read
    const subDir = join(baseDir, 'locked');
    mkdirSync(subDir, { mode: 0o700 });
    const lockedFile = join(subDir, 'smee-channel');
    writeFileSync(lockedFile, 'https://smee.io/whatever');
    chmodSync(lockedFile, 0o000);

    const provisionedUrl = 'https://smee.io/newAFTERerr';
    const fetchMock = vi.fn().mockResolvedValue(make302(provisionedUrl));

    // Skip if running as root (chmod 0o000 is ignored for root)
    if (process.getuid && process.getuid() === 0) {
      chmodSync(lockedFile, 0o600);
      return;
    }

    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath: lockedFile,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await resolver.resolve();

    // Restore permissions for cleanup
    chmodSync(lockedFile, 0o600);

    expect(result?.source).toBe('provisioned');
    const warn = mockLogger.warn.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('Failed to read persisted'),
    );
    expect(warn).toBeDefined();
  });

  it('T6: tier 3 first attempt fails, sleep(1000) called, second attempt succeeds', async () => {
    const provisionedUrl = 'https://smee.io/newRETRY';
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(make302(provisionedUrl));
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: sleepMock,
    });

    const result = await resolver.resolve();

    expect(result).toEqual({ channelUrl: provisionedUrl, source: 'provisioned' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(1000);
  });

  it('T7: tier 3 both attempts fail → L4 log + null return', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: sleepMock,
    });

    const result = await resolver.resolve();

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const l4 = mockLogger.warn.mock.calls.find(
      (c) => c[1] === 'Failed to provision smee channel after 2 attempts — cluster is webhook-less, falling back to polling',
    );
    expect(l4).toBeDefined();
    const [ctx] = l4 as [Record<string, unknown>, string];
    expect(ctx.attempts).toBe(2);
    expect(ctx.lastError).toBeDefined();
  });

  it('T8: 302 with missing Location → treated as failure, retries', async () => {
    const provisionedUrl = 'https://smee.io/newAFTERmiss';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(make302(null))
      .mockResolvedValueOnce(make302(provisionedUrl));
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: sleepMock,
    });

    const result = await resolver.resolve();

    expect(result?.source).toBe('provisioned');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
  });

  it('T9: 302 with wrong-shape Location → treated as failure, retries', async () => {
    const provisionedUrl = 'https://smee.io/newAFTERwrong';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(make302('https://evil.com/x'))
      .mockResolvedValueOnce(make302(provisionedUrl));
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: sleepMock,
    });

    const result = await resolver.resolve();

    expect(result?.source).toBe('provisioned');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('T10: provision succeeds, persist fails → L5 log + null (no in-memory URL)', async () => {
    // Create a read-only parent directory for the channel file path.
    // Skip if root (permissions ignored).
    if (process.getuid && process.getuid() === 0) {
      return;
    }
    const roDir = join(baseDir, 'readonly');
    mkdirSync(roDir, { mode: 0o500 });
    const roPath = join(roDir, 'smee-channel');

    const provisionedUrl = 'https://smee.io/newBUTfail';
    const fetchMock = vi.fn().mockResolvedValue(make302(provisionedUrl));

    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath: roPath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await resolver.resolve();

    // Restore permissions for cleanup
    chmodSync(roDir, 0o700);

    expect(result).toBeNull();
    const l5 = mockLogger.warn.mock.calls.find(
      (c) =>
        c[1] ===
        'Provisioned smee channel URL but failed to persist — dropping URL to avoid orphaned GitHub webhook accumulation',
    );
    expect(l5).toBeDefined();
  });

  it('T11: fetch never resolves → AbortSignal.timeout fires → treated as failure, retries', async () => {
    // Real AbortSignal.timeout(5000) — use fake timers to fast-forward
    vi.useFakeTimers();

    const provisionedUrl = 'https://smee.io/newAFTERabort';
    const fetchMock = vi.fn().mockImplementation((_url, init: RequestInit | undefined) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            reject(err);
          });
        }
      });
    });
    // Second attempt succeeds so we don't have to wait for another 5s
    fetchMock.mockImplementationOnce((_url, init: RequestInit | undefined) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            reject(err);
          });
        }
      });
    });
    fetchMock.mockImplementationOnce(() => Promise.resolve(make302(provisionedUrl)));

    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: sleepMock,
    });

    const resultPromise = resolver.resolve();
    // Advance past first attempt's 5s timeout
    await vi.advanceTimersByTimeAsync(5001);
    // Now sleep(1000) should have been queued; advance past it
    await vi.advanceTimersByTimeAsync(1001);

    const result = await resultPromise;

    vi.useRealTimers();

    expect(result?.source).toBe('provisioned');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('T12: written file has mode 0600', async () => {
    const provisionedUrl = 'https://smee.io/newPERM';
    const fetchMock = vi.fn().mockResolvedValue(make302(provisionedUrl));

    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await resolver.resolve();

    const stat = statSync(channelFilePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('T13: written file has exactly the URL, no trailing newline', async () => {
    const provisionedUrl = 'https://smee.io/newEXACT';
    const fetchMock = vi.fn().mockResolvedValue(make302(provisionedUrl));

    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    await resolver.resolve();

    const contents = readFileSync(channelFilePath, 'utf-8');
    expect(contents).toBe(provisionedUrl);
    expect(contents.endsWith('\n')).toBe(false);
  });

  it('T14: file with trailing newline is trimmed on read, still matches regex, still returned', async () => {
    const persistedUrl = 'https://smee.io/persistedNL';
    writeFileSync(channelFilePath, persistedUrl + '\n');

    const fetchMock = vi.fn();
    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const result = await resolver.resolve();

    expect(result).toEqual({ channelUrl: persistedUrl, source: 'persisted' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('T15: 307 with valid Location → success, no retries (FR-005 case 1)', async () => {
    const provisionedUrl = 'https://smee.io/3dCinhK6djyd2yK';
    const fetchMock = vi.fn().mockResolvedValue(makeRedirect(307, provisionedUrl));
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: sleepMock,
    });

    const result = await resolver.resolve();

    expect(result).toEqual({ channelUrl: provisionedUrl, source: 'provisioned' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).not.toHaveBeenCalled();
  });

  it('T16: 200 with empty body / no Location → failure, retries exhausted, lastError matches FR-007 wording (FR-005 case 2, SC-003)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: sleepMock,
    });

    const result = await resolver.resolve();

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledWith(1000);
    const l4 = mockLogger.warn.mock.calls.find(
      (c) =>
        c[1] ===
        'Failed to provision smee channel after 2 attempts — cluster is webhook-less, falling back to polling',
    );
    expect(l4).toBeDefined();
    const [ctx] = l4 as [Record<string, unknown>, string];
    expect(ctx.lastError).toBe('expected 3xx with Location, got 200');
  });

  it('T17: 307 with Location not matching SMEE_URL_PATTERN → failure via pattern check (FR-005 case 3)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeRedirect(307, 'https://evil.com/x'));
    const sleepMock = vi.fn().mockResolvedValue(undefined);

    const resolver = new SmeeChannelResolver(mockLogger, {
      channelFilePath,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: sleepMock,
    });

    const result = await resolver.resolve();

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const l4 = mockLogger.warn.mock.calls.find(
      (c) =>
        c[1] ===
        'Failed to provision smee channel after 2 attempts — cluster is webhook-less, falling back to polling',
    );
    expect(l4).toBeDefined();
    const [ctx] = l4 as [Record<string, unknown>, string];
    expect(ctx.lastError).toBe('Location does not match SMEE_URL_PATTERN');
  });

  describe('workspaceMirrorPath (#980)', () => {
    let mirrorPath: string;

    beforeEach(() => {
      mirrorPath = join(baseDir, 'workspace', '.generacy', 'cockpit', 'smee-channel');
    });

    it('M1: tier-3 provisioning + mirror success → mirror file exists, mode 0644, bare-URL bytes', async () => {
      const provisionedUrl = 'https://smee.io/newMIRROR1';
      const fetchMock = vi.fn().mockResolvedValue(make302(provisionedUrl));

      const resolver = new SmeeChannelResolver(mockLogger, {
        channelFilePath,
        workspaceMirrorPath: mirrorPath,
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      });

      const result = await resolver.resolve();

      expect(result).toEqual({ channelUrl: provisionedUrl, source: 'provisioned' });
      expect(readFileSync(mirrorPath, 'utf-8')).toBe(provisionedUrl);
      expect(statSync(mirrorPath).mode & 0o777).toBe(0o644);
    });

    it('M2: tier-3 provisioning + cluster-internal write success + mirror EACCES → resolver returns provisioned; one warn; mirror file absent', async () => {
      // Skip if root (chmod 0500 is ignored for root)
      if (process.getuid && process.getuid() === 0) return;

      const provisionedUrl = 'https://smee.io/newMIRROR2';
      const fetchMock = vi.fn().mockResolvedValue(make302(provisionedUrl));

      // Read-only parent dir for the mirror to force EACCES on mkdir/rename.
      const roDir = join(baseDir, 'ro-workspace');
      mkdirSync(roDir, { mode: 0o500 });
      const roMirror = join(roDir, '.generacy', 'cockpit', 'smee-channel');

      const resolver = new SmeeChannelResolver(mockLogger, {
        channelFilePath,
        workspaceMirrorPath: roMirror,
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      });

      const result = await resolver.resolve();

      // Restore for cleanup
      chmodSync(roDir, 0o700);

      expect(result).toEqual({ channelUrl: provisionedUrl, source: 'provisioned' });
      const mirrorWarn = mockLogger.warn.mock.calls.find(
        (c) => c[1] === 'Workspace mirror write failed — operator sessions may fall back to polling',
      );
      expect(mirrorWarn).toBeDefined();
    });

    it('M3: tier-2 persisted-read + mirror missing → mirror written', async () => {
      const persistedUrl = 'https://smee.io/persMIRROR3';
      writeFileSync(channelFilePath, persistedUrl);

      const resolver = new SmeeChannelResolver(mockLogger, {
        channelFilePath,
        workspaceMirrorPath: mirrorPath,
      });

      const result = await resolver.resolve();

      expect(result).toEqual({ channelUrl: persistedUrl, source: 'persisted' });
      expect(readFileSync(mirrorPath, 'utf-8')).toBe(persistedUrl);
      expect(statSync(mirrorPath).mode & 0o777).toBe(0o644);
    });

    it('M4: tier-2 persisted-read + mirror bytes equal persisted URL → no writeFile called for mirror', async () => {
      const persistedUrl = 'https://smee.io/persMIRROR4';
      writeFileSync(channelFilePath, persistedUrl);
      mkdirSync(dirnameFn(mirrorPath), { recursive: true });
      writeFileSync(mirrorPath, persistedUrl, { mode: 0o644 });
      const originalMtime = statSync(mirrorPath).mtimeMs;

      // Give a slight delay so any re-write would be detectable
      await new Promise((r) => setTimeout(r, 10));

      const resolver = new SmeeChannelResolver(mockLogger, {
        channelFilePath,
        workspaceMirrorPath: mirrorPath,
      });

      const result = await resolver.resolve();

      expect(result).toEqual({ channelUrl: persistedUrl, source: 'persisted' });
      // mtime unchanged proves writeFile was not called for the mirror.
      expect(statSync(mirrorPath).mtimeMs).toBe(originalMtime);
    });

    it('M5: tier-2 persisted-read + mirror bytes differ → mirror re-written', async () => {
      const persistedUrl = 'https://smee.io/persMIRROR5NEW';
      writeFileSync(channelFilePath, persistedUrl);
      mkdirSync(dirnameFn(mirrorPath), { recursive: true });
      writeFileSync(mirrorPath, 'https://smee.io/persMIRROR5OLD', { mode: 0o644 });

      const resolver = new SmeeChannelResolver(mockLogger, {
        channelFilePath,
        workspaceMirrorPath: mirrorPath,
      });

      const result = await resolver.resolve();

      expect(result).toEqual({ channelUrl: persistedUrl, source: 'persisted' });
      expect(readFileSync(mirrorPath, 'utf-8')).toBe(persistedUrl);
    });

    it('M6: workspaceMirrorPath undefined → no mirror write attempted; behavior identical to today', async () => {
      const provisionedUrl = 'https://smee.io/newNOMIRROR';
      const fetchMock = vi.fn().mockResolvedValue(make302(provisionedUrl));

      const resolver = new SmeeChannelResolver(mockLogger, {
        channelFilePath,
        fetch: fetchMock as unknown as typeof globalThis.fetch,
      });

      const result = await resolver.resolve();

      expect(result).toEqual({ channelUrl: provisionedUrl, source: 'provisioned' });
      // No mirror-related warn
      const mirrorWarn = mockLogger.warn.mock.calls.find(
        (c) => c[1] === 'Workspace mirror write failed — operator sessions may fall back to polling',
      );
      expect(mirrorWarn).toBeUndefined();
    });
  });

  describe('adopt tier (#1005)', () => {
    const repos = [{ owner: 'testorg', repo: 'testrepo' }];

    it('T-adopt-1: callback returns valid smee URL → source: adopted, persisted written, no fetch', async () => {
      const adoptedUrl = 'https://smee.io/ADOPTED123';
      const fetchMock = vi.fn();
      const discoverExistingChannel = vi.fn().mockResolvedValue(adoptedUrl);

      const resolver = new SmeeChannelResolver(mockLogger, {
        channelFilePath,
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        repos,
        discoverExistingChannel,
      });

      const result = await resolver.resolve();

      expect(result).toEqual({ channelUrl: adoptedUrl, source: 'adopted' });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(discoverExistingChannel).toHaveBeenCalledTimes(1);
      expect(discoverExistingChannel).toHaveBeenCalledWith(repos);
      // Persisted file was written.
      expect(readFileSync(channelFilePath, 'utf-8')).toBe(adoptedUrl);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { channelUrl: adoptedUrl, source: 'adopted' },
        'Adopted existing smee channel URL from repo webhook',
      );
    });

    it('T-adopt-2: callback returns null → falls through to provision, no persist-adopt write', async () => {
      const provisionedUrl = 'https://smee.io/PROVISIONED456';
      const fetchMock = vi.fn().mockResolvedValue(make302(provisionedUrl));
      const discoverExistingChannel = vi.fn().mockResolvedValue(null);

      const resolver = new SmeeChannelResolver(mockLogger, {
        channelFilePath,
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        repos,
        discoverExistingChannel,
      });

      const result = await resolver.resolve();

      expect(result).toEqual({ channelUrl: provisionedUrl, source: 'provisioned' });
      expect(discoverExistingChannel).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('T-adopt-3: callback throws once then returns URL → sleep(1000) once, callback called twice, source: adopted', async () => {
      const adoptedUrl = 'https://smee.io/RETRYADOPT';
      const fetchMock = vi.fn();
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const discoverExistingChannel = vi
        .fn()
        .mockRejectedValueOnce(new Error('transient GH 403'))
        .mockResolvedValueOnce(adoptedUrl);

      const resolver = new SmeeChannelResolver(mockLogger, {
        channelFilePath,
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        sleep: sleepMock,
        repos,
        discoverExistingChannel,
      });

      const result = await resolver.resolve();

      expect(result).toEqual({ channelUrl: adoptedUrl, source: 'adopted' });
      expect(discoverExistingChannel).toHaveBeenCalledTimes(2);
      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).toHaveBeenCalledWith(1000);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('T-adopt-4: callback throws twice → falls through to provision, sleep called once, no persist-adopt write', async () => {
      const provisionedUrl = 'https://smee.io/AFTERRETRYFAIL';
      const fetchMock = vi.fn().mockResolvedValue(make302(provisionedUrl));
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const discoverExistingChannel = vi
        .fn()
        .mockRejectedValueOnce(new Error('gh 500 #1'))
        .mockRejectedValueOnce(new Error('gh 500 #2'));

      const resolver = new SmeeChannelResolver(mockLogger, {
        channelFilePath,
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        sleep: sleepMock,
        repos,
        discoverExistingChannel,
      });

      const result = await resolver.resolve();

      expect(result).toEqual({ channelUrl: provisionedUrl, source: 'provisioned' });
      expect(discoverExistingChannel).toHaveBeenCalledTimes(2);
      // sleep(1000) called once between adopt attempts (adopt-tier retry).
      // provision succeeded first try so no additional sleep from provision.
      expect(sleepMock).toHaveBeenCalledTimes(1);
      const adoptFailWarn = mockLogger.warn.mock.calls.find(
        (c) => c[1] === 'Adopt callback failed after N attempts — falling through to provision',
      );
      expect(adoptFailWarn).toBeDefined();
      const [ctx] = adoptFailWarn as [Record<string, unknown>, string];
      expect(ctx.attempts).toBe(2);
      expect(ctx.lastError).toBe('gh 500 #2');
    });

    it('T-adopt-5: callback returns URL, persist fails → still returns source: adopted, warn logged', async () => {
      // Skip if root (chmod 0500 is ignored for root)
      if (process.getuid && process.getuid() === 0) return;

      const roDir = join(baseDir, 'ro-adopt');
      mkdirSync(roDir, { mode: 0o500 });
      const roPath = join(roDir, 'smee-channel');

      const adoptedUrl = 'https://smee.io/PERSISTFAIL';
      const fetchMock = vi.fn();
      const discoverExistingChannel = vi.fn().mockResolvedValue(adoptedUrl);

      const resolver = new SmeeChannelResolver(mockLogger, {
        channelFilePath: roPath,
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        repos,
        discoverExistingChannel,
      });

      const result = await resolver.resolve();

      // Restore for cleanup
      chmodSync(roDir, 0o700);

      expect(result).toEqual({ channelUrl: adoptedUrl, source: 'adopted' });
      const persistWarn = mockLogger.warn.mock.calls.find(
        (c) =>
          c[1] ===
          'Adopted smee channel URL but failed to persist — next boot will re-run adopt tier',
      );
      expect(persistWarn).toBeDefined();
      const [ctx] = persistWarn as [Record<string, unknown>, string];
      expect(ctx.path).toBe(roPath);
      expect(ctx.url).toBe(adoptedUrl);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('T-adopt-6: callback returns malformed URL → treated as null, falls through to provision, no retry', async () => {
      const provisionedUrl = 'https://smee.io/AFTERMALFORMED';
      const fetchMock = vi.fn().mockResolvedValue(make302(provisionedUrl));
      const sleepMock = vi.fn().mockResolvedValue(undefined);
      const discoverExistingChannel = vi.fn().mockResolvedValue('not-a-smee-url');

      const resolver = new SmeeChannelResolver(mockLogger, {
        channelFilePath,
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        sleep: sleepMock,
        repos,
        discoverExistingChannel,
      });

      const result = await resolver.resolve();

      expect(result).toEqual({ channelUrl: provisionedUrl, source: 'provisioned' });
      // No adopt retry on malformed URL — legitimate miss.
      expect(discoverExistingChannel).toHaveBeenCalledTimes(1);
      const malformedWarn = mockLogger.warn.mock.calls.find(
        (c) =>
          c[1] ===
          'Adopt callback returned URL not matching SMEE_URL_PATTERN — falling through',
      );
      expect(malformedWarn).toBeDefined();
      const [ctx] = malformedWarn as [Record<string, unknown>, string];
      expect(ctx.result).toBe('not-a-smee-url');
      expect(ctx.source).toBe('adopted');
    });

    it('T-adopt-7 (SC-003): valid persisted file → discoverExistingChannel is NEVER called', async () => {
      const persistedUrl = 'https://smee.io/PERSISTEDHIT';
      writeFileSync(channelFilePath, persistedUrl);

      const fetchMock = vi.fn();
      const discoverExistingChannel = vi.fn();

      const resolver = new SmeeChannelResolver(mockLogger, {
        channelFilePath,
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        repos,
        discoverExistingChannel,
      });

      const result = await resolver.resolve();

      expect(result).toEqual({ channelUrl: persistedUrl, source: 'persisted' });
      expect(discoverExistingChannel).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
