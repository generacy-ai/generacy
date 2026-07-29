import { describe, it, expect, vi } from 'vitest';
import {
  createRetainedCockpitEvents,
  type RetainedEvent,
} from '../retained-cockpit-events.js';
import type { ClusterRelayClient } from '../../types/relay.js';

function makeEvent(index: number, approxBytes = 100): RetainedEvent {
  return {
    event: 'cluster.cockpit',
    data: { seq: index },
    timestamp: `2026-07-21T00:00:0${index}.000Z`,
    approxBytes,
  };
}

function makeMockClient(overrides: Partial<ClusterRelayClient> = {}): ClusterRelayClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    registerPendingFrame: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    isConnected: true,
    ...overrides,
  };
}

describe('createRetainedCockpitEvents', () => {
  it('enqueue preserves FIFO insertion order on drain', () => {
    const retainer = createRetainedCockpitEvents({
      maxCount: 100,
      maxBytes: 10_000,
    });
    for (let i = 0; i < 3; i += 1) {
      retainer.enqueue(makeEvent(i));
    }
    const client = makeMockClient();
    const result = retainer.drainInto(client);
    expect(result).toEqual({ sent: 3, failed: 0 });
    expect((client.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { data: { seq: number } }).data.seq,
    )).toEqual([0, 1, 2]);
  });

  it('drops oldest on count-cap overflow and reports droppedCount', () => {
    const retainer = createRetainedCockpitEvents({
      maxCount: 3,
      maxBytes: 10_000,
    });
    for (let i = 0; i < 3; i += 1) {
      const result = retainer.enqueue(makeEvent(i));
      expect(result.droppedCount).toBe(0);
    }
    const overflow = retainer.enqueue(makeEvent(3));
    expect(overflow.droppedCount).toBe(1);
    expect(retainer.size().count).toBe(3);
    const client = makeMockClient();
    retainer.drainInto(client);
    const seqs = (client.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { data: { seq: number } }).data.seq,
    );
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('drops oldest on byte-cap overflow', () => {
    const retainer = createRetainedCockpitEvents({
      maxCount: 100,
      maxBytes: 300,
    });
    retainer.enqueue(makeEvent(0, 100));
    retainer.enqueue(makeEvent(1, 100));
    retainer.enqueue(makeEvent(2, 100));
    expect(retainer.size().bytes).toBe(300);
    const overflow = retainer.enqueue(makeEvent(3, 100));
    expect(overflow.droppedCount).toBe(1);
    expect(retainer.size().bytes).toBe(300);
    const client = makeMockClient();
    retainer.drainInto(client);
    const seqs = (client.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { data: { seq: number } }).data.seq,
    );
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('drops multiple entries in one enqueue when the new event pushes over cap', () => {
    const retainer = createRetainedCockpitEvents({
      maxCount: 100,
      maxBytes: 250,
    });
    retainer.enqueue(makeEvent(0, 100));
    retainer.enqueue(makeEvent(1, 100));
    // New event is 200 bytes; total would be 400, must drop both existing to fit.
    const overflow = retainer.enqueue(makeEvent(2, 200));
    expect(overflow.droppedCount).toBe(2);
    expect(retainer.size().count).toBe(1);
    expect(retainer.size().bytes).toBe(200);
  });

  it('drainInto sends in FIFO order and removes on success', () => {
    const retainer = createRetainedCockpitEvents({
      maxCount: 100,
      maxBytes: 10_000,
    });
    retainer.enqueue(makeEvent(0));
    retainer.enqueue(makeEvent(1));
    const client = makeMockClient();
    const result = retainer.drainInto(client);
    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(retainer.size().count).toBe(0);
    expect(retainer.size().bytes).toBe(0);
  });

  it('drainInto stops on first synchronous throw and preserves remaining events', () => {
    const retainer = createRetainedCockpitEvents({
      maxCount: 100,
      maxBytes: 10_000,
    });
    retainer.enqueue(makeEvent(0));
    retainer.enqueue(makeEvent(1));
    retainer.enqueue(makeEvent(2));

    let callCount = 0;
    const send = vi.fn(() => {
      callCount += 1;
      if (callCount === 2) throw new Error('transport failed');
    });
    const client = makeMockClient({ send });

    const result = retainer.drainInto(client);
    expect(result).toEqual({ sent: 1, failed: 1 });
    expect(retainer.size().count).toBe(2);
  });

  it('size() reports accurate count and bytes', () => {
    const retainer = createRetainedCockpitEvents({
      maxCount: 100,
      maxBytes: 10_000,
    });
    expect(retainer.size()).toEqual({ count: 0, bytes: 0 });
    retainer.enqueue(makeEvent(0, 42));
    retainer.enqueue(makeEvent(1, 58));
    expect(retainer.size()).toEqual({ count: 2, bytes: 100 });
  });

  // #1066 — retain path is a byte-for-byte pass-through. `frameId` (or any
  // caller-supplied field) already survives, but pin it against future
  // refactors that might filter or reshape `data` on drain.
  it('#1066 retention preserves frameId across enqueue → drain byte-for-byte', () => {
    const retainer = createRetainedCockpitEvents({
      maxCount: 100,
      maxBytes: 10_000,
    });
    const withFrameId: RetainedEvent = {
      event: 'cluster.cockpit',
      data: { seq: 0, type: 'gate-open', gateId: 'a'.repeat(24), frameId: 'frm_kept' },
      timestamp: '2026-07-21T00:00:00.000Z',
      approxBytes: 100,
    };
    const withoutFrameId: RetainedEvent = {
      event: 'cluster.cockpit',
      data: { seq: 1, type: 'gate-open', gateId: 'b'.repeat(24) },
      timestamp: '2026-07-21T00:00:01.000Z',
      approxBytes: 100,
    };
    retainer.enqueue(withFrameId);
    retainer.enqueue(withoutFrameId);

    const client = makeMockClient();
    const result = retainer.drainInto(client);
    expect(result).toEqual({ sent: 2, failed: 0 });

    const sends = (client.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { data: Record<string, unknown> }).data,
    );
    // Byte-for-byte equality against the enqueued `data` object references.
    expect(sends[0]).toEqual(withFrameId.data);
    expect(sends[1]).toEqual(withoutFrameId.data);
    // The event that had no frameId still has no frameId on the wire.
    expect(Object.hasOwn(sends[1] as object, 'frameId')).toBe(false);
  });

  // #1077 review — drainInto must re-arm the pending-frame TTL at send time.
  // The accept-time entry may have already expired during the outage that
  // caused the retain, and the getRelayClient()===null accept-time path never
  // registered an entry at all.
  it('#1077 drainInto re-arms pending-frame TTL for entries with a frameId', () => {
    const retainer = createRetainedCockpitEvents({
      maxCount: 100,
      maxBytes: 10_000,
    });
    retainer.enqueue({
      event: 'cluster.cockpit',
      data: {
        type: 'gate-open',
        gateId: 'g'.repeat(24),
        frameId: 'frm_drain_open',
      },
      timestamp: '2026-07-21T00:00:00.000Z',
      approxBytes: 100,
    });
    retainer.enqueue({
      event: 'cluster.cockpit',
      data: {
        type: 'gate-outcome',
        gateId: 'h'.repeat(24),
        frameId: 'frm_drain_ack',
      },
      timestamp: '2026-07-21T00:00:01.000Z',
      approxBytes: 100,
    });

    const client = makeMockClient();
    const result = retainer.drainInto(client);
    expect(result).toEqual({ sent: 2, failed: 0 });

    const registerCalls = (
      client.registerPendingFrame as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(registerCalls).toHaveLength(2);
    expect(registerCalls[0]).toEqual([
      'frm_drain_open',
      { frameType: 'gate-open', gateId: 'g'.repeat(24) },
    ]);
    expect(registerCalls[1]).toEqual([
      'frm_drain_ack',
      { frameType: 'gate-outcome', gateId: 'h'.repeat(24) },
    ]);

    // Re-arm MUST precede send for each entry so the entry is present when the
    // reply comes back.
    const sendCalls = (client.send as ReturnType<typeof vi.fn>).mock.calls;
    expect(sendCalls).toHaveLength(2);
    const register0Order = (
      client.registerPendingFrame as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0];
    const send0Order = (
      client.send as ReturnType<typeof vi.fn>
    ).mock.invocationCallOrder[0];
    expect(register0Order).toBeLessThan(send0Order);
  });

  it('#1077 drainInto skips re-arm for entries without a valid frameId', () => {
    const retainer = createRetainedCockpitEvents({
      maxCount: 100,
      maxBytes: 10_000,
    });
    retainer.enqueue({
      event: 'cluster.cockpit',
      data: { type: 'gate-open', gateId: 'a'.repeat(24) },
      timestamp: '2026-07-21T00:00:00.000Z',
      approxBytes: 100,
    });
    retainer.enqueue({
      event: 'cluster.cockpit',
      data: { type: 'gate-open', gateId: 'b'.repeat(24), frameId: '' },
      timestamp: '2026-07-21T00:00:01.000Z',
      approxBytes: 100,
    });
    retainer.enqueue({
      event: 'cluster.cockpit',
      data: {
        type: 'unknown-subtype',
        gateId: 'c'.repeat(24),
        frameId: 'frm_wrong_type',
      },
      timestamp: '2026-07-21T00:00:02.000Z',
      approxBytes: 100,
    });

    const client = makeMockClient();
    retainer.drainInto(client);
    expect(client.registerPendingFrame).not.toHaveBeenCalled();
    expect(client.send).toHaveBeenCalledTimes(3);
  });

  it('clear() empties the queue', () => {
    const retainer = createRetainedCockpitEvents({
      maxCount: 100,
      maxBytes: 10_000,
    });
    retainer.enqueue(makeEvent(0));
    retainer.enqueue(makeEvent(1));
    retainer.clear();
    expect(retainer.size()).toEqual({ count: 0, bytes: 0 });
    const client = makeMockClient();
    retainer.drainInto(client);
    expect(client.send).not.toHaveBeenCalled();
  });
});
