/**
 * Unit coverage for `EpicRefSetHolder` — the shared owner of the bound epic's
 * resolved ref set. Exercises first-resolve population, retain-on-failure after
 * first success, `refreshOnMiss()` throttle + single-flight coalescing, and the
 * caller-visible membership outcome for an unknown ref.
 */
import { describe, expect, it, vi } from 'vitest';
import type { GhWrapper, ResolvedEpic } from '@generacy-ai/cockpit';
import { EpicRefSetHolder } from '../ref-set-holder.js';

function makeLogger(): { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), info: vi.fn() };
}

function resolvedWith(
  epicRepo: string,
  epicNumber: number,
  childRefs: Array<{ repo: string; number: number }>,
): ResolvedEpic {
  const repos = Array.from(
    new Set([epicRepo, ...childRefs.map((r) => r.repo)]),
  ).sort();
  return {
    epic: { repo: epicRepo, number: epicNumber },
    parsed: { phases: [], adhocRefs: [], allRefs: childRefs, warnings: [] },
    repos,
    bodyHash: 'x',
  };
}

const gh = {} as GhWrapper;

describe('EpicRefSetHolder', () => {
  it('current is null until the first successful resolve, then populated', async () => {
    const resolve = vi.fn(async () =>
      resolvedWith('owner/repo', 5, [{ repo: 'owner/repo', number: 42 }]),
    );
    const holder = new EpicRefSetHolder({
      epicRef: 'owner/repo#5',
      gh,
      logger: makeLogger(),
      resolve: resolve as never,
    });

    expect(holder.current).toBeNull();
    expect(holder.resolved).toBeNull();

    await holder.refresh();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(holder.current).not.toBeNull();
    // Both epic and child are members, keyed owner/repo#number lowercased.
    expect(holder.current!.issues.has('owner/repo#5')).toBe(true);
    expect(holder.current!.issues.has('owner/repo#42')).toBe(true);
    expect(holder.resolved).not.toBeNull();
  });

  it('refresh() rethrows when the first resolve fails (no prior set)', async () => {
    const resolve = vi.fn(async () => {
      throw new Error('boom');
    });
    const logger = makeLogger();
    const holder = new EpicRefSetHolder({
      epicRef: 'owner/repo#5',
      gh,
      logger,
      resolve: resolve as never,
    });

    await expect(holder.refresh()).rejects.toThrow(/boom/);
    expect(holder.current).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('failed refresh after a first success retains the previous set (never null)', async () => {
    let call = 0;
    const resolve = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return resolvedWith('owner/repo', 5, [{ repo: 'owner/repo', number: 42 }]);
      }
      throw new Error('later failure');
    });
    const holder = new EpicRefSetHolder({
      epicRef: 'owner/repo#5',
      gh,
      logger: makeLogger(),
      resolve: resolve as never,
    });

    await holder.refresh();
    const first = holder.current;
    expect(first).not.toBeNull();

    // Second refresh fails but must not throw and must retain the prior set.
    await expect(holder.refresh()).resolves.toBeUndefined();
    expect(holder.current).toBe(first);
  });

  it('refreshOnMiss() throttles to at most one resolve per interval', async () => {
    let clock = 1_000_000;
    const resolve = vi.fn(async () =>
      resolvedWith('owner/repo', 5, [{ repo: 'owner/repo', number: 42 }]),
    );
    const holder = new EpicRefSetHolder({
      epicRef: 'owner/repo#5',
      gh,
      logger: makeLogger(),
      resolve: resolve as never,
      missRefreshMinIntervalMs: 30_000,
      now: () => clock,
    });

    expect(await holder.refreshOnMiss()).toBe('resolved');
    expect(resolve).toHaveBeenCalledTimes(1);

    // Within the window → no resolve. The armed window came from a SUCCESSFUL
    // resolve, so the set is fresh and the outcome is authoritative.
    clock += 10_000;
    expect(await holder.refreshOnMiss()).toBe('throttled');
    expect(resolve).toHaveBeenCalledTimes(1);

    // Past the window → resolves again.
    clock += 25_000;
    expect(await holder.refreshOnMiss()).toBe('resolved');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('refreshOnMiss() reports throttled-stale when the armed window came from a FAILED resolve', async () => {
    let clock = 1_000_000;
    const resolve = vi.fn(async () => {
      throw new Error('rate limited');
    });
    const holder = new EpicRefSetHolder({
      epicRef: 'owner/repo#5',
      gh,
      logger: makeLogger(),
      resolve: resolve as never,
      missRefreshMinIntervalMs: 30_000,
      now: () => clock,
    });

    expect(await holder.refreshOnMiss()).toBe('failed');
    expect(resolve).toHaveBeenCalledTimes(1);

    // Inside the window the throttle suppresses the retry, but the set is NOT
    // authoritative — the only attempt failed. Callers must not treat a miss
    // here as proof the ref is foreign.
    clock += 10_000;
    expect(await holder.refreshOnMiss()).toBe('throttled-stale');
    expect(resolve).toHaveBeenCalledTimes(1);

    // Self-limiting: once the window expires a real attempt happens again.
    clock += 25_000;
    expect(await holder.refreshOnMiss()).toBe('failed');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('refreshOnMiss() never throws when the resolve fails', async () => {
    const resolve = vi.fn(async () => {
      throw new Error('miss failure');
    });
    const logger = makeLogger();
    const holder = new EpicRefSetHolder({
      epicRef: 'owner/repo#5',
      gh,
      logger,
      resolve: resolve as never,
    });

    await expect(holder.refreshOnMiss()).resolves.toBe('failed');
    expect(holder.current).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('coalesces overlapping refresh() calls onto one in-flight resolve', async () => {
    let release: (v: ResolvedEpic) => void = () => undefined;
    const gate = new Promise<ResolvedEpic>((res) => {
      release = res;
    });
    const resolve = vi.fn(() => gate);
    const holder = new EpicRefSetHolder({
      epicRef: 'owner/repo#5',
      gh,
      logger: makeLogger(),
      resolve: resolve as never,
    });

    const a = holder.refresh();
    const b = holder.refresh();
    expect(resolve).toHaveBeenCalledTimes(1);

    release(resolvedWith('owner/repo', 5, [{ repo: 'owner/repo', number: 42 }]));
    await Promise.all([a, b]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(holder.current).not.toBeNull();
  });

  it('an unknown ref stays foreign after a refresh — membership excludes it', async () => {
    const resolve = vi.fn(async () =>
      resolvedWith('owner/repo', 5, [{ repo: 'owner/repo', number: 42 }]),
    );
    const holder = new EpicRefSetHolder({
      epicRef: 'owner/repo#5',
      gh,
      logger: makeLogger(),
      resolve: resolve as never,
    });

    await holder.refreshOnMiss();
    // A ref never in the epic's tree remains absent after the miss refresh.
    expect(holder.current!.issues.has('owner/repo#999')).toBe(false);
  });
});
