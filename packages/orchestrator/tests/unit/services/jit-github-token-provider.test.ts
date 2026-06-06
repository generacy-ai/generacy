import { describe, it, expect, vi } from 'vitest';
import {
  JitTokenError,
  type JitGitTokenClient,
  type JitGitTokenResponse,
} from '@generacy-ai/control-plane';
import {
  createJitGithubTokenProvider,
  resolveSocketPath,
} from '../../../src/services/jit-github-token-provider.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function makeAuthHealth() {
  return {
    recordResult: vi.fn(),
  };
}

interface MockClientOptions {
  fetchImpl?: (credentialId?: string) => Promise<JitGitTokenResponse>;
}

function makeMockClient(opts: MockClientOptions = {}): JitGitTokenClient & {
  fetch: ReturnType<typeof vi.fn>;
} {
  const fetchImpl =
    opts.fetchImpl ??
    (async () => ({
      token: 'ghs_initial',
      expiresAt: new Date(Date.now() + 60 * 60_000),
    }));
  return {
    fetch: vi.fn(fetchImpl),
  } as JitGitTokenClient & { fetch: ReturnType<typeof vi.fn> };
}

describe('createJitGithubTokenProvider', () => {
  const CRED_ID = 'cred-github-app';

  it('first call → calls client.fetch and returns token', async () => {
    const client = makeMockClient({
      fetchImpl: async () => ({
        token: 'ghs_first',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      }),
    });
    const provider = createJitGithubTokenProvider({
      client,
      credentialId: CRED_ID,
      logger: makeLogger(),
    });

    const token = await provider();

    expect(token).toBe('ghs_first');
    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(client.fetch).toHaveBeenCalledWith(CRED_ID);
  });

  it('second call within cache window → returns cached token without refetch', async () => {
    const client = makeMockClient();
    const provider = createJitGithubTokenProvider({
      client,
      credentialId: CRED_ID,
      logger: makeLogger(),
    });

    await provider();
    await provider();

    expect(client.fetch).toHaveBeenCalledTimes(1);
  });

  it('call within 5 min of expiry → refetches', async () => {
    const baseNow = new Date('2026-06-05T12:00:00Z');
    let current = baseNow;
    const client = makeMockClient({
      fetchImpl: async () => ({
        token: `ghs_${current.toISOString()}`,
        // expires in 4 minutes — inside the 5-min refresh window from baseNow+0
        expiresAt: new Date(current.getTime() + 4 * 60_000),
      }),
    });
    const provider = createJitGithubTokenProvider({
      client,
      credentialId: CRED_ID,
      logger: makeLogger(),
      now: () => current,
    });

    await provider();
    // Even on the very next call, the token is within the refresh window, so refetch.
    await provider();

    expect(client.fetch).toHaveBeenCalledTimes(2);
  });

  it('call after expiry → refetches', async () => {
    let current = new Date('2026-06-05T12:00:00Z');
    const client = makeMockClient({
      fetchImpl: async () => ({
        token: 'ghs_refresh',
        expiresAt: new Date(current.getTime() + 60 * 60_000),
      }),
    });
    const provider = createJitGithubTokenProvider({
      client,
      credentialId: CRED_ID,
      logger: makeLogger(),
      now: () => current,
    });

    await provider();
    // Fast-forward past expiry
    current = new Date(current.getTime() + 90 * 60_000);
    await provider();

    expect(client.fetch).toHaveBeenCalledTimes(2);
  });

  it('client.fetch throws JitTokenError → provider rethrows + records to authHealth', async () => {
    const client = makeMockClient({
      fetchImpl: async () => {
        throw new JitTokenError('CLOUD_AUTH_REJECTED', 'rejected');
      },
    });
    const authHealth = makeAuthHealth();
    const provider = createJitGithubTokenProvider({
      client,
      credentialId: CRED_ID,
      authHealth,
      logger: makeLogger(),
    });

    await expect(provider()).rejects.toMatchObject({
      name: 'JitTokenError',
      code: 'CLOUD_AUTH_REJECTED',
    });
    expect(authHealth.recordResult).toHaveBeenCalledTimes(1);
    expect(authHealth.recordResult).toHaveBeenCalledWith(CRED_ID, {
      ok: false,
      statusCode: 503,
    });
  });

  it('client.fetch throws non-JitTokenError → wraps in CONTROL_SOCKET_UNREACHABLE', async () => {
    const client = makeMockClient({
      fetchImpl: async () => {
        throw new Error('whoops');
      },
    });
    const authHealth = makeAuthHealth();
    const provider = createJitGithubTokenProvider({
      client,
      credentialId: CRED_ID,
      authHealth,
      logger: makeLogger(),
    });

    await expect(provider()).rejects.toMatchObject({
      name: 'JitTokenError',
      code: 'CONTROL_SOCKET_UNREACHABLE',
      message: 'whoops',
    });
    expect(authHealth.recordResult).toHaveBeenCalledWith(CRED_ID, {
      ok: false,
      statusCode: 503,
    });
  });

  it('stale entry is discarded on refresh failure', async () => {
    let current = new Date('2026-06-05T12:00:00Z');
    let mode: 'ok' | 'fail' = 'ok';
    const client = makeMockClient({
      fetchImpl: async () => {
        if (mode === 'fail') throw new JitTokenError('CLOUD_UNREACHABLE', 'down');
        return {
          token: 'ghs_seed',
          expiresAt: new Date(current.getTime() + 60 * 60_000),
        };
      },
    });
    const provider = createJitGithubTokenProvider({
      client,
      credentialId: CRED_ID,
      logger: makeLogger(),
      now: () => current,
    });

    // Seed cache
    await provider();
    expect(client.fetch).toHaveBeenCalledTimes(1);

    // Move within refresh window so the next call refreshes
    current = new Date(current.getTime() + 56 * 60_000);
    mode = 'fail';
    await expect(provider()).rejects.toBeInstanceOf(JitTokenError);
    expect(client.fetch).toHaveBeenCalledTimes(2);

    // Next call should attempt fetch again (stale was discarded), not serve cached.
    await expect(provider()).rejects.toBeInstanceOf(JitTokenError);
    expect(client.fetch).toHaveBeenCalledTimes(3);
  });

  it('authHealth undefined → provider still throws on failure (no NPE)', async () => {
    const client = makeMockClient({
      fetchImpl: async () => {
        throw new JitTokenError('CLOUD_UNREACHABLE', 'down');
      },
    });
    const provider = createJitGithubTokenProvider({
      client,
      credentialId: CRED_ID,
      logger: makeLogger(),
    });

    await expect(provider()).rejects.toBeInstanceOf(JitTokenError);
  });

  it('authHealth.recordResult throws → original JitTokenError is still thrown', async () => {
    const client = makeMockClient({
      fetchImpl: async () => {
        throw new JitTokenError('CLOUD_UNREACHABLE', 'down');
      },
    });
    const authHealth = {
      recordResult: vi.fn(() => {
        throw new Error('sink-broke');
      }),
    };
    const provider = createJitGithubTokenProvider({
      client,
      credentialId: CRED_ID,
      authHealth,
      logger: makeLogger(),
    });

    await expect(provider()).rejects.toMatchObject({
      code: 'CLOUD_UNREACHABLE',
      message: 'down',
    });
  });

  it('custom refreshWindowMs is honored', async () => {
    let current = new Date('2026-06-05T12:00:00Z');
    const client = makeMockClient({
      fetchImpl: async () => ({
        token: 'ghs_x',
        expiresAt: new Date(current.getTime() + 10 * 60_000), // 10-min expiry
      }),
    });
    // With a 1-min refresh window, a 10-min-expiry token should NOT refresh on the second call.
    const provider = createJitGithubTokenProvider({
      client,
      credentialId: CRED_ID,
      refreshWindowMs: 60_000,
      logger: makeLogger(),
      now: () => current,
    });

    await provider();
    await provider();

    expect(client.fetch).toHaveBeenCalledTimes(1);
  });

  it('injected now() controls expiry decisions', async () => {
    let current = new Date('2026-06-05T12:00:00Z');
    const client = makeMockClient({
      fetchImpl: async () => ({
        token: 'ghs_x',
        expiresAt: new Date(current.getTime() + 60 * 60_000),
      }),
    });
    const provider = createJitGithubTokenProvider({
      client,
      credentialId: CRED_ID,
      logger: makeLogger(),
      now: () => current,
    });

    await provider();
    // Jump past expiry
    current = new Date(current.getTime() + 2 * 60 * 60_000);
    await provider();

    expect(client.fetch).toHaveBeenCalledTimes(2);
  });

  it('two concurrent cache-miss calls both succeed', async () => {
    let fetchCount = 0;
    const client = makeMockClient({
      fetchImpl: async () => {
        fetchCount += 1;
        return {
          token: `ghs_${fetchCount}`,
          expiresAt: new Date(Date.now() + 60 * 60_000),
        };
      },
    });
    const provider = createJitGithubTokenProvider({
      client,
      credentialId: CRED_ID,
      logger: makeLogger(),
    });

    const [a, b] = await Promise.all([provider(), provider()]);

    expect(typeof a).toBe('string');
    expect(typeof b).toBe('string');
    // Both calls allowed (no in-process coalescing — upstream GitTokenManager handles that)
    expect(fetchCount).toBeGreaterThanOrEqual(1);
    expect(fetchCount).toBeLessThanOrEqual(2);
  });

  it('returns a non-empty string on success (never undefined)', async () => {
    const client = makeMockClient({
      fetchImpl: async () => ({
        token: 'ghs_present',
        expiresAt: new Date(Date.now() + 60 * 60_000),
      }),
    });
    const provider = createJitGithubTokenProvider({
      client,
      credentialId: CRED_ID,
      logger: makeLogger(),
    });

    const value = await provider();
    expect(value).toBeDefined();
    expect(typeof value).toBe('string');
    expect(value.length).toBeGreaterThan(0);
  });
});

describe('resolveSocketPath', () => {
  it('returns GIT_TOKEN_SOCKET_PATH when set', () => {
    expect(resolveSocketPath({ GIT_TOKEN_SOCKET_PATH: '/a' })).toBe('/a');
  });

  it('returns CONTROL_PLANE_SOCKET_PATH when GIT_TOKEN_SOCKET_PATH is absent', () => {
    expect(resolveSocketPath({ CONTROL_PLANE_SOCKET_PATH: '/b' })).toBe('/b');
  });

  it('GIT_TOKEN_SOCKET_PATH wins over CONTROL_PLANE_SOCKET_PATH', () => {
    expect(
      resolveSocketPath({
        GIT_TOKEN_SOCKET_PATH: '/a',
        CONTROL_PLANE_SOCKET_PATH: '/b',
      }),
    ).toBe('/a');
  });

  it('falls back to default when neither env is set', () => {
    expect(resolveSocketPath({})).toBe('/run/generacy-control-plane/control.sock');
  });
});
