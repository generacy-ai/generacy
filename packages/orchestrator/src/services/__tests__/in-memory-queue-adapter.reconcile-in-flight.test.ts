import { describe, it, expect, beforeEach, vi } from 'vitest';
import { InMemoryQueueAdapter } from '../in-memory-queue-adapter.js';
import type { QueueItem } from '../../types/index.js';

/**
 * #1058 / FR-005 — in-memory adapter's no-op contract for `reconcileInFlight`.
 *
 * In-memory `pending`, `claimed`, and `inFlightSet` are first-class fields
 * in the same process that cannot diverge without a bug in the adapter
 * itself (caught by `in-memory-queue-adapter.enqueue-invariant.test.ts`).
 * So `reconcileInFlight` returns `reconciled: 0` at every step of a healthy
 * cycle and never `SREM`s anything.
 *
 * `scanned` returns the set size rather than 0 so a call site logging
 * `scanned` sees a truthful "sweep did examine the set" signal.
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
    issueNumber: overrides.issueNumber ?? 1058,
    workflowName: overrides.workflowName ?? 'speckit-feature',
    command: overrides.command ?? 'implement',
    priority: overrides.priority ?? 1000,
    enqueuedAt: overrides.enqueuedAt ?? new Date().toISOString(),
    metadata: overrides.metadata,
    queueReason: overrides.queueReason ?? 'new',
  };
}

describe('InMemoryQueueAdapter.reconcileInFlight — #1058 no-op contract', () => {
  let logger: ReturnType<typeof createLogger>;
  let adapter: InMemoryQueueAdapter;

  beforeEach(() => {
    logger = createLogger();
    adapter = new InMemoryQueueAdapter(logger, {
      maxRetries: 3,
      maxRunDurationMs: 1_800_000,
    });
  });

  it('returns the ReconcileReport shape with all counters zero on an empty queue', async () => {
    const report = await adapter.reconcileInFlight();
    expect(report).toEqual({
      scanned: 0,
      reconciled: 0,
      skippedAlreadyGone: 0,
      trackedFirstSeen: 0,
    });
  });

  it('scanned reflects inFlightSet size after enqueue (truthful signal, not 0)', async () => {
    await adapter.enqueueIfAbsent(makeItem({ issueNumber: 1058 }));
    const report = await adapter.reconcileInFlight();
    expect(report.scanned).toBe(1);
    // No SREM ever happens: reconciled must stay zero throughout.
    expect(report.reconciled).toBe(0);
    expect(report.skippedAlreadyGone).toBe(0);
    expect(report.trackedFirstSeen).toBe(0);
  });

  it('healthy enqueue → claim → complete cycle produces zero reconciled at every step', async () => {
    await adapter.enqueueIfAbsent(makeItem({ issueNumber: 1058 }));
    // Step 1: item in pending / inFlightSet
    let report = await adapter.reconcileInFlight();
    expect(report.reconciled).toBe(0);
    expect(report.scanned).toBe(1);

    // Step 2: claim it.
    const claimed = await adapter.claim('worker-A');
    expect(claimed).not.toBeNull();
    report = await adapter.reconcileInFlight();
    expect(report.reconciled).toBe(0);
    expect(report.scanned).toBe(1);

    // Step 3: complete it.
    await adapter.complete('worker-A', claimed!);
    report = await adapter.reconcileInFlight();
    expect(report.reconciled).toBe(0);
    // inFlightSet cleared by complete.
    expect(report.scanned).toBe(0);
  });

  it('accepts an explicit now argument (parameter-parity with Redis adapter)', async () => {
    const report = await adapter.reconcileInFlight(1_700_000_000_000);
    expect(report).toEqual({
      scanned: 0,
      reconciled: 0,
      skippedAlreadyGone: 0,
      trackedFirstSeen: 0,
    });
  });
});
