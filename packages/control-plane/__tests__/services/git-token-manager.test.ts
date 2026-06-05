import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGitTokenManager } from '../../src/services/git-token-manager.js';
import type { CloudPullResponse } from '../../src/types/git-token.js';
import { GitHelperError } from '../../src/types/git-token.js';

interface FakeCloud {
  pull: ReturnType<typeof vi.fn<[string], Promise<CloudPullResponse>>>;
}

function fakeCloud(impl: (credentialId: string) => Promise<CloudPullResponse>): FakeCloud {
  return { pull: vi.fn(impl) };
}

const FIVE_MIN = 5 * 60 * 1000;

function makeNow() {
  let current = Date.UTC(2026, 0, 1, 0, 0, 0);
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}

describe('GitTokenManager.getToken', () => {
  let clock: ReturnType<typeof makeNow>;

  beforeEach(() => {
    clock = makeNow();
  });

  it('cold start: calls cloud and returns fresh entry', async () => {
    const expiresAt = new Date(clock.now() + 60 * 60 * 1000).toISOString();
    const cloud = fakeCloud(async () => ({ token: 't1', expiresAt }));
    const manager = createGitTokenManager({ cloudPullClient: cloud as any, now: clock.now });

    const entry = await manager.getToken('github-app');

    expect(cloud.pull).toHaveBeenCalledTimes(1);
    expect(cloud.pull).toHaveBeenCalledWith('github-app');
    expect(entry.token).toBe('t1');
    expect(entry.credentialId).toBe('github-app');
    expect(entry.expiresAt.toISOString()).toBe(expiresAt);
    expect(entry.fetchedAt.getTime()).toBe(clock.now());
  });

  it('warm cache: second call within validity returns cached entry without cloud call', async () => {
    const expiresAt = new Date(clock.now() + 60 * 60 * 1000).toISOString();
    const cloud = fakeCloud(async () => ({ token: 't1', expiresAt }));
    const manager = createGitTokenManager({ cloudPullClient: cloud as any, now: clock.now });

    const first = await manager.getToken('github-app');
    clock.advance(60_000); // 1 minute later, still > 5 min from expiry
    const second = await manager.getToken('github-app');

    expect(cloud.pull).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('pre-expiry refresh: get within 5min of expiry triggers synchronous refresh', async () => {
    let call = 0;
    const cloud = fakeCloud(async () => {
      call++;
      // each call mints a new token valid for 1h from current clock
      return { token: `t${call}`, expiresAt: new Date(clock.now() + 60 * 60 * 1000).toISOString() };
    });
    const manager = createGitTokenManager({ cloudPullClient: cloud as any, now: clock.now });

    const first = await manager.getToken('github-app');
    expect(first.token).toBe('t1');

    // Jump forward so we are inside the 5-min pre-expiry window
    clock.advance(60 * 60 * 1000 - FIVE_MIN + 1_000);

    const second = await manager.getToken('github-app');
    expect(cloud.pull).toHaveBeenCalledTimes(2);
    expect(second.token).toBe('t2');
  });

  it('exactly 5 minutes from expiry: refresh triggers (≤ window boundary)', async () => {
    let call = 0;
    const cloud = fakeCloud(async () => {
      call++;
      return { token: `t${call}`, expiresAt: new Date(clock.now() + 60 * 60 * 1000).toISOString() };
    });
    const manager = createGitTokenManager({ cloudPullClient: cloud as any, now: clock.now });

    await manager.getToken('github-app');
    clock.advance(60 * 60 * 1000 - FIVE_MIN); // exactly 5 minutes to expiry
    await manager.getToken('github-app');

    expect(cloud.pull).toHaveBeenCalledTimes(2);
  });

  it('concurrent gets collapse to a single in-flight cloud call', async () => {
    let resolve: (v: CloudPullResponse) => void = () => {};
    const cloud = fakeCloud(
      () =>
        new Promise<CloudPullResponse>((r) => {
          resolve = r;
        }),
    );
    const manager = createGitTokenManager({ cloudPullClient: cloud as any, now: clock.now });

    const a = manager.getToken('github-app');
    const b = manager.getToken('github-app');
    const c = manager.getToken('github-app');

    expect(cloud.pull).toHaveBeenCalledTimes(1);

    const expiresAt = new Date(clock.now() + 60 * 60 * 1000).toISOString();
    resolve({ token: 't-shared', expiresAt });

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra.token).toBe('t-shared');
    expect(rb.token).toBe('t-shared');
    expect(rc.token).toBe('t-shared');
    expect(cloud.pull).toHaveBeenCalledTimes(1);
  });

  it('cloud error is propagated as GitHelperError and cache stays empty (no stale fallback)', async () => {
    const cloud = fakeCloud(async () => {
      throw new GitHelperError('CLOUD_UNREACHABLE', 'down');
    });
    const manager = createGitTokenManager({ cloudPullClient: cloud as any, now: clock.now });

    await expect(manager.getToken('github-app')).rejects.toMatchObject({
      code: 'CLOUD_UNREACHABLE',
    });

    // Next call should retry (no stale entry to serve).
    await expect(manager.getToken('github-app')).rejects.toMatchObject({
      code: 'CLOUD_UNREACHABLE',
    });
    expect(cloud.pull).toHaveBeenCalledTimes(2);
  });

  it('invariant: expiresAt > fetchedAt on every successful entry', async () => {
    const expiresAt = new Date(clock.now() + 60 * 60 * 1000).toISOString();
    const cloud = fakeCloud(async () => ({ token: 't', expiresAt }));
    const manager = createGitTokenManager({ cloudPullClient: cloud as any, now: clock.now });

    const entry = await manager.getToken('github-app');
    expect(entry.expiresAt.getTime()).toBeGreaterThan(entry.fetchedAt.getTime());
  });

  it('refresh after error: subsequent successful pull populates cache', async () => {
    let fail = true;
    const cloud = fakeCloud(async () => {
      if (fail) throw new GitHelperError('CLOUD_UPSTREAM_ERROR', 'fail');
      return { token: 't-ok', expiresAt: new Date(clock.now() + 60 * 60 * 1000).toISOString() };
    });
    const manager = createGitTokenManager({ cloudPullClient: cloud as any, now: clock.now });

    await expect(manager.getToken('github-app')).rejects.toMatchObject({
      code: 'CLOUD_UPSTREAM_ERROR',
    });
    fail = false;
    const entry = await manager.getToken('github-app');
    expect(entry.token).toBe('t-ok');
  });
});
