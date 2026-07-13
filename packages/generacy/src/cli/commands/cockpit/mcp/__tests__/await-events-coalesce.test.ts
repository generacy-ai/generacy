import { describe, it, expect } from 'vitest';
import { EpicEventBus } from '../event-bus.js';
import { AWAIT_EVENTS_DEFAULTS } from '../schemas.js';
import type { CockpitStreamEvent } from '../../watch/stream-event.js';

function makeEvent(n: number): CockpitStreamEvent {
  return {
    type: 'issue-transition',
    ts: '2026-07-11T00:00:00.000Z',
    repo: 'generacy-ai/generacy',
    kind: 'issue',
    number: n,
    from: null,
    to: 'waiting:clarification',
    sourceLabel: 'waiting-for:clarification',
    url: `https://github.com/generacy-ai/generacy/issues/${n}`,
    event: 'label-change',
    labels: ['waiting-for:clarification'],
  };
}

describe('cockpit_await_events: batching (via EpicEventBus)', () => {
  it('SC-006: AWAIT_EVENTS_DEFAULTS has the locked-in fixture values', () => {
    expect(AWAIT_EVENTS_DEFAULTS.maxWaitMs).toBe(55_000);
    expect(AWAIT_EVENTS_DEFAULTS.coalesceWindowMs).toBe(3_000);
    expect(AWAIT_EVENTS_DEFAULTS.maxBatchSize).toBe(256);
  });

  it('1 event → wait coalesceWindowMs → drain sibling burst → return batch', async () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
    const promise = bus.waitFor({
      sinceCursor: 0,
      maxWaitMs: 1000,
      coalesceWindowMs: 200,
      maxBatchSize: 100,
    });
    bus.emit(makeEvent(918));
    // Emit a sibling within the coalesce window.
    setTimeout(() => bus.emit(makeEvent(919)), 20);
    const result = await promise;
    expect(result.entries.length).toBeGreaterThanOrEqual(2);
    expect((result.entries[0]!.event as { number?: number }).number).toBe(918);
    expect((result.entries[1]!.event as { number?: number }).number).toBe(919);
  });

  it('empty window → maxWaitMs timeout returns empty batch', async () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
    const result = await bus.waitFor({
      sinceCursor: 0,
      maxWaitMs: 50,
      coalesceWindowMs: 3000,
      maxBatchSize: 256,
    });
    expect(result.entries.length).toBe(0);
  });

  it('maxBatchSize soft-cap triggers early close with continuation cursor', async () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
    for (let i = 0; i < 10; i += 1) bus.emit(makeEvent(918 + i));
    const result = await bus.waitFor({
      sinceCursor: 0,
      maxWaitMs: 0,
      coalesceWindowMs: 0,
      maxBatchSize: 4,
    });
    expect(result.entries.length).toBe(4);
    const last = result.entries[result.entries.length - 1]!;
    expect(last.cursor).toBe(4);
    const next = await bus.waitFor({
      sinceCursor: last.cursor,
      maxWaitMs: 0,
      coalesceWindowMs: 0,
      maxBatchSize: 4,
    });
    expect(next.entries.map((e) => e.cursor)).toEqual([5, 6, 7, 8]);
  });
});
