import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseAdvanceMonitorService } from '../services/base-advance-monitor-service.js';
import type { ResumeItem } from '../services/base-advance-monitor-service.js';
import type { PhaseTracker } from '../types/monitor.js';
import type { Logger } from '../worker/types.js';

/**
 * End-to-end regression coverage for #892's convergence property:
 *
 * Three cross-dependent siblings all red at `failed:validate`. Sibling #1
 * merges → base SHA advances → monitor re-arms #2 and #3 with the new SHA.
 * After #2 merges → base SHA advances again → monitor re-arms only #3.
 * Steady-state (no SHA change) → no further enqueues.
 *
 * The actual re-validate → green → merge sequence is exercised by the
 * downstream cockpit-resume + PhaseLoop path; this test drives the monitor
 * side of that pipeline and asserts the enqueue cadence and idempotency
 * that makes convergence possible.
 */

function makeLogger(): Logger {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
  l.child.mockReturnValue(l);
  return l as unknown as Logger;
}

function makeTracker() {
  const seen = new Set<string>();
  return {
    seen,
    isDuplicate: vi.fn(),
    markProcessed: vi.fn(),
    clear: vi.fn(),
    tryMarkProcessed: vi.fn(),
    isDuplicateRaw: vi.fn(async (k: string) => seen.has(k)),
    markProcessedRaw: vi.fn(async (k: string) => { seen.add(k); }),
  } as unknown as PhaseTracker & { seen: Set<string> };
}

function makePR(number: number, base = 'develop', labels = ['failed:validate']) {
  return {
    number,
    title: `PR #${number}`,
    body: '',
    state: 'open' as const,
    draft: false,
    head: { ref: `feat/${number}`, sha: '0'.repeat(40), repo: 'acme/widgets' },
    base: { ref: base, sha: '0'.repeat(40), repo: 'acme/widgets' },
    labels: labels.map((n) => ({ name: n, color: '', description: '' })),
    created_at: '',
    updated_at: '',
  };
}

describe('base-advance e2e: 3-sibling convergence (#892 regression #1 + #4)', () => {
  let logger: Logger;
  let tracker: ReturnType<typeof makeTracker>;
  let enqueue: ReturnType<typeof vi.fn>;
  let enqueuedItems: ResumeItem[];

  beforeEach(() => {
    logger = makeLogger();
    tracker = makeTracker();
    enqueuedItems = [];
    enqueue = vi.fn(async (item: ResumeItem) => {
      enqueuedItems.push(item);
    });
  });

  it('sibling merges advance base SHA → monitor re-arms remaining siblings exactly once per SHA', async () => {
    // World state — the stub github reflects what the poll cycle would see.
    const SHA_BEFORE_ANY_MERGE = 'a'.repeat(40);
    const SHA_AFTER_1_MERGED = 'b'.repeat(40);
    const SHA_AFTER_2_MERGED = 'c'.repeat(40);

    // Mutable world.
    let openPRs = [
      makePR(1), makePR(2), makePR(3),
    ];
    let currentBaseSha = SHA_BEFORE_ANY_MERGE;

    const github = {
      listOpenPullRequests: vi.fn(async () => openPRs),
      getRefHeadSha: vi.fn(async () => currentBaseSha),
    };

    const svc = new BaseAdvanceMonitorService(
      logger,
      () => github as any,
      { pollIntervalMs: 60_000, repositories: [{ owner: 'acme', repo: 'widgets' }], concurrency: 4 },
      tracker,
      enqueue,
    );

    // Cycle 1 — boot re-arm: all three PRs enqueued once for SHA_BEFORE_ANY_MERGE.
    await svc.pollCycle();
    expect(enqueuedItems.map((e) => e.issueNumber).sort()).toEqual([1, 2, 3]);
    expect(new Set(enqueuedItems.map((e) => e.newSha))).toEqual(new Set([SHA_BEFORE_ANY_MERGE]));

    // Cycle 2 — steady state, same SHA, same open PRs → no re-enqueues.
    enqueuedItems.length = 0;
    await svc.pollCycle();
    expect(enqueuedItems.length).toBe(0);

    // Sibling #1 merges → world advances.
    openPRs = openPRs.filter((p) => p.number !== 1);
    currentBaseSha = SHA_AFTER_1_MERGED;

    // Cycle 3 — new SHA, remaining PRs re-armed.
    await svc.pollCycle();
    expect(enqueuedItems.map((e) => e.issueNumber).sort()).toEqual([2, 3]);
    expect(new Set(enqueuedItems.map((e) => e.newSha))).toEqual(new Set([SHA_AFTER_1_MERGED]));

    // Cycle 4 — steady state on the new SHA → no re-enqueues.
    enqueuedItems.length = 0;
    await svc.pollCycle();
    expect(enqueuedItems.length).toBe(0);

    // Sibling #2 merges → world advances again.
    openPRs = openPRs.filter((p) => p.number !== 2);
    currentBaseSha = SHA_AFTER_2_MERGED;

    // Cycle 5 — new SHA, only #3 remaining.
    await svc.pollCycle();
    expect(enqueuedItems.map((e) => e.issueNumber)).toEqual([3]);
    expect(enqueuedItems[0]!.newSha).toBe(SHA_AFTER_2_MERGED);

    // Sibling #3 merges → world is empty.
    openPRs = [];

    // Cycle 6 — nothing left to enqueue, no getRefHeadSha call either.
    enqueuedItems.length = 0;
    (github.getRefHeadSha as any).mockClear();
    await svc.pollCycle();
    expect(enqueuedItems.length).toBe(0);
    expect(github.getRefHeadSha).not.toHaveBeenCalled();
  });

  it('idempotency: an unchanged SHA over 5 cycles produces exactly 3 enqueues (one per PR)', async () => {
    const openPRs = [makePR(1), makePR(2), makePR(3)];
    const github = {
      listOpenPullRequests: vi.fn(async () => openPRs),
      getRefHeadSha: vi.fn(async () => 'f'.repeat(40)),
    };
    const svc = new BaseAdvanceMonitorService(
      logger,
      () => github as any,
      { pollIntervalMs: 60_000, repositories: [{ owner: 'acme', repo: 'widgets' }], concurrency: 4 },
      tracker,
      enqueue,
    );

    for (let i = 0; i < 5; i++) await svc.pollCycle();

    // Exactly 3 enqueues total — one per PR, on the first cycle.
    expect(enqueuedItems.length).toBe(3);
  });
});
