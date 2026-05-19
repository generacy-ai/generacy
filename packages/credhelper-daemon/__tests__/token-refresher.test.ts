import { CredentialStore } from '../src/credential-store.js';
import { TokenRefresher } from '../src/token-refresher.js';
import type { CredentialCacheEntry } from '../src/types.js';

function makeEntry(overrides?: Partial<CredentialCacheEntry>): CredentialCacheEntry {
  return {
    value: { value: 'original-value' },
    expiresAt: new Date(Date.now() + 4000),
    available: true,
    credentialType: 'mock',
    ...overrides,
  };
}

describe('TokenRefresher', () => {
  let store: CredentialStore;
  let refresher: TokenRefresher;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new CredentialStore();
    refresher = new TokenRefresher(store);
  });

  afterEach(() => {
    refresher.cancelAll();
    vi.useRealTimers();
  });

  it('fires refresh at 75% of TTL', async () => {
    const mintFn = vi.fn().mockResolvedValue({
      value: { value: 'refreshed-value' },
      expiresAt: new Date(Date.now() + 8000),
    });

    store.set('s1', 'c1', makeEntry());
    refresher.scheduleRefresh('s1', 'c1', 4000, mintFn);

    // At 75% of 4000ms = 3000ms, the refresh should fire
    await vi.advanceTimersByTimeAsync(3000);

    expect(mintFn).toHaveBeenCalledTimes(1);
  });

  it('updates the store on successful refresh', async () => {
    const mintFn = vi.fn().mockResolvedValue({
      value: { value: 'refreshed-value' },
      expiresAt: new Date(Date.now() + 8000),
    });

    store.set('s1', 'c1', makeEntry());
    refresher.scheduleRefresh('s1', 'c1', 4000, mintFn);

    await vi.advanceTimersByTimeAsync(3000);

    const entry = store.get('s1', 'c1');
    expect(entry).toBeDefined();
    expect(entry!.value).toEqual({ value: 'refreshed-value' });
    expect(entry!.available).toBe(true);
  });

  it('marks credential unavailable on mint failure', async () => {
    const mintFn = vi.fn().mockRejectedValue(new Error('mint exploded'));

    store.set('s1', 'c1', makeEntry());
    refresher.scheduleRefresh('s1', 'c1', 4000, mintFn);

    await vi.advanceTimersByTimeAsync(3000);

    const entry = store.get('s1', 'c1');
    expect(entry).toBeDefined();
    expect(entry!.available).toBe(false);
  });

  it('cancelSession clears all timers for a session', async () => {
    const mintFn = vi.fn().mockResolvedValue({
      value: { value: 'refreshed-value' },
      expiresAt: new Date(Date.now() + 8000),
    });

    store.set('s1', 'c1', makeEntry());
    refresher.scheduleRefresh('s1', 'c1', 4000, mintFn);

    refresher.cancelSession('s1');

    await vi.advanceTimersByTimeAsync(4000);

    expect(mintFn).not.toHaveBeenCalled();
  });

  it('cancelAll clears all timers across all sessions', async () => {
    const mintFn1 = vi.fn().mockResolvedValue({
      value: { value: 'v1' },
      expiresAt: new Date(Date.now() + 8000),
    });
    const mintFn2 = vi.fn().mockResolvedValue({
      value: { value: 'v2' },
      expiresAt: new Date(Date.now() + 8000),
    });

    store.set('s1', 'c1', makeEntry());
    store.set('s2', 'c2', makeEntry());
    refresher.scheduleRefresh('s1', 'c1', 4000, mintFn1);
    refresher.scheduleRefresh('s2', 'c2', 4000, mintFn2);

    refresher.cancelAll();

    await vi.advanceTimersByTimeAsync(4000);

    expect(mintFn1).not.toHaveBeenCalled();
    expect(mintFn2).not.toHaveBeenCalled();
  });

  it('reschedules after successful refresh', async () => {
    const newExpiresAt = new Date(Date.now() + 3000 + 10000);
    const mintFn = vi.fn().mockResolvedValue({
      value: { value: 'refreshed-value' },
      expiresAt: newExpiresAt,
    });

    store.set('s1', 'c1', makeEntry());
    refresher.scheduleRefresh('s1', 'c1', 4000, mintFn);

    // First refresh fires at 3000ms (75% of 4000)
    await vi.advanceTimersByTimeAsync(3000);
    expect(mintFn).toHaveBeenCalledTimes(1);

    // After first refresh, a new timer is scheduled with 75% of the new TTL.
    // The new TTL is ~10000ms (newExpiresAt - Date.now() at the time of reschedule).
    // 75% of 10000 = 7500ms.
    await vi.advanceTimersByTimeAsync(7500);
    expect(mintFn).toHaveBeenCalledTimes(2);
  });
});
