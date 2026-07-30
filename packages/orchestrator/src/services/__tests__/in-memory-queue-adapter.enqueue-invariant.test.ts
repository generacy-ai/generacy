import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryQueueAdapter } from '../in-memory-queue-adapter.js';
import type { QueueItem } from '../../types/index.js';

/**
 * #1060 — regression suite mirroring the Redis adapter's invariant tests
 * against the in-memory adapter. Asserts `inFlightSet` membership at every
 * step of the enqueue → claim → release-retry → complete sequence
 * (in-memory has no orphan-reclaim). SC-003 parity is enforced separately
 * in `queue-adapter-parity.test.ts`.
 */

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

function makeItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    owner: overrides.owner ?? 'generacy-ai',
    repo: overrides.repo ?? 'generacy',
    issueNumber: overrides.issueNumber ?? 1060,
    workflowName: overrides.workflowName ?? 'speckit-feature',
    command: overrides.command ?? 'implement',
    priority: overrides.priority ?? 1000,
    enqueuedAt: overrides.enqueuedAt ?? new Date().toISOString(),
    metadata: overrides.metadata,
    queueReason: overrides.queueReason ?? 'new',
  };
}

describe('InMemoryQueueAdapter.enqueue — #1060 in-flight-SET invariant', () => {
  let logger: ReturnType<typeof createLogger>;
  let adapter: InMemoryQueueAdapter;

  beforeEach(() => {
    logger = createLogger();
    adapter = new InMemoryQueueAdapter(logger, {
      maxRetries: 3,
      maxRunDurationMs: 1_800_000,
    });
  });

  it('(a) enqueue({ itemKey }) → hasInFlight(itemKey) === true', async () => {
    const enqueued = await adapter.enqueue(makeItem({ issueNumber: 1060 }));

    expect(enqueued).toBe(true);
    expect(await adapter.hasInFlight('generacy-ai/generacy#1060')).toBe(true);
  });

  it('(b) enqueue → enqueue same key → second returns false, no double-add', async () => {
    const first = await adapter.enqueue(makeItem({ issueNumber: 1060 }));
    const second = await adapter.enqueue(makeItem({
      issueNumber: 1060,
      enqueuedAt: new Date(Date.now() + 1000).toISOString(),
    }));

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await adapter.getQueueDepth()).toBe(1);
  });

  it('(c) enqueue → claim → hasInFlight(itemKey) === true (in-flight preserved across claim)', async () => {
    await adapter.enqueue(makeItem({ issueNumber: 1060 }));
    const claimed = await adapter.claim('worker-A');

    expect(claimed).not.toBeNull();
    expect(claimed!.issueNumber).toBe(1060);
    expect(await adapter.getQueueDepth()).toBe(0);
    expect(await adapter.hasInFlight('generacy-ai/generacy#1060')).toBe(true);
  });

  it('(d) enqueue → claim → release-retry → complete: in-flight tracked correctly across lifecycle (SC-004)', async () => {
    const itemKey = 'generacy-ai/generacy#1060';

    // Step 1: enqueue
    await adapter.enqueue(makeItem({ issueNumber: 1060 }));
    expect(await adapter.hasInFlight(itemKey)).toBe(true);
    expect(await adapter.getQueueDepth()).toBe(1);

    // Step 2: claim
    const claimed = await adapter.claim('worker-A');
    expect(claimed).not.toBeNull();
    expect(await adapter.hasInFlight(itemKey)).toBe(true);
    expect(await adapter.getQueueDepth()).toBe(0);
    expect(await adapter.getActiveWorkerCount()).toBe(1);

    // Step 3: release (retry path — attempt count 1 < maxRetries=3)
    await adapter.release('worker-A', claimed!);
    expect(await adapter.hasInFlight(itemKey)).toBe(true);
    expect(await adapter.getQueueDepth()).toBe(1);
    expect(await adapter.getActiveWorkerCount()).toBe(0);

    // Step 4: claim again then complete
    const finalClaim = await adapter.claim('worker-B');
    expect(finalClaim).not.toBeNull();
    await adapter.complete('worker-B', finalClaim!);

    // After complete: item is no longer in flight anywhere.
    expect(await adapter.hasInFlight(itemKey)).toBe(false);
    expect(await adapter.getQueueDepth()).toBe(0);
    expect(await adapter.getActiveWorkerCount()).toBe(0);
  });

  it('drop path emits emitDropLog line with { itemKey, source: "enqueue", reason: "in-flight" } fields', async () => {
    await adapter.enqueue(makeItem({ issueNumber: 1060 }));
    await adapter.enqueue(makeItem({
      issueNumber: 1060,
      enqueuedAt: new Date(Date.now() + 1000).toISOString(),
    }));

    const dropCall = logger.info.mock.calls.find(
      (c) => (c[0] as Record<string, unknown> | undefined)?.source === 'enqueue',
    );
    expect(dropCall, 'expected an info-level drop log with source=enqueue').toBeDefined();
    expect(dropCall![0]).toMatchObject({
      itemKey: 'generacy-ai/generacy#1060',
      source: 'enqueue',
      reason: 'in-flight',
    });
    expect(dropCall![1]).toBe('Dropping enqueue (item already in flight)');
  });

  it('cross-verb dedupe: after enqueue succeeds, enqueueIfAbsent returns false for same itemKey', async () => {
    const first = await adapter.enqueue(makeItem({ issueNumber: 1060 }));
    const second = await adapter.enqueueIfAbsent(makeItem({
      issueNumber: 1060,
      queueReason: 'resume',
    }));

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await adapter.getQueueDepth()).toBe(1);
  });

  it('cross-verb dedupe (inverse): after enqueueIfAbsent succeeds, enqueue returns false for same itemKey', async () => {
    const first = await adapter.enqueueIfAbsent(makeItem({ issueNumber: 1060, queueReason: 'resume' }));
    const second = await adapter.enqueue(makeItem({ issueNumber: 1060, queueReason: 'new' }));

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(await adapter.getQueueDepth()).toBe(1);
  });
});
