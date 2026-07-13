import { describe, it, expect } from 'vitest';
import { EpicEventBus, encodeCursor, decodeCursor, INSTANCE_NONCE } from '../event-bus.js';
import type { CockpitStreamEvent } from '../../watch/stream-event.js';

function makeEvent(number: number, ts = '2026-07-11T00:00:00.000Z'): CockpitStreamEvent {
  return {
    type: 'issue-transition',
    ts,
    repo: 'generacy-ai/generacy',
    kind: 'issue',
    number,
    from: null,
    to: 'waiting:clarification',
    sourceLabel: 'waiting-for:clarification',
    url: `https://github.com/generacy-ai/generacy/issues/${number}`,
    event: 'label-change',
    labels: ['waiting-for:clarification'],
  };
}

const BUS_NONCE_A = '0123456789abcdef';
const BUS_NONCE_B = 'fedcba9876543210';
const FAKE_PNONCE = 'aaaaaaaaaaaaaaaa';

describe('EpicEventBus', () => {
  it('assigns monotonically-increasing cursors from 1', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917', nonce: BUS_NONCE_A });
    const a = bus.emit(makeEvent(918));
    const b = bus.emit(makeEvent(919));
    expect(a.cursor).toBe(1);
    expect(b.cursor).toBe(2);
  });

  it('exposes the per-bus nonce via a readable field', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917', nonce: BUS_NONCE_A });
    expect(bus.busNonce).toBe(BUS_NONCE_A);
  });

  it('generates a random per-bus nonce when the option is omitted', () => {
    const bus1 = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
    const bus2 = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
    expect(bus1.busNonce).toMatch(/^[0-9a-f]{16}$/);
    expect(bus2.busNonce).toMatch(/^[0-9a-f]{16}$/);
    expect(bus1.busNonce).not.toBe(bus2.busNonce);
  });

  it('encodes/decodes cursor round-trip including both nonces', () => {
    const s = encodeCursor('generacy-ai/generacy#917', 42, INSTANCE_NONCE, BUS_NONCE_A);
    const decoded = decodeCursor(s);
    expect(decoded).toEqual({
      epic: 'generacy-ai/generacy#917',
      position: 42,
      pnonce: INSTANCE_NONCE,
      bnonce: BUS_NONCE_A,
    });
  });

  it('decodeCursor treats a garbled nonce as absent', () => {
    const raw = Buffer.from(
      JSON.stringify({
        epic: 'generacy-ai/generacy#917',
        position: 3,
        pnonce: 'NOT_HEX_zzzz1234',
        bnonce: BUS_NONCE_A,
      }),
      'utf-8',
    ).toString('base64');
    const decoded = decodeCursor(raw);
    expect(decoded).toEqual({
      epic: 'generacy-ai/generacy#917',
      position: 3,
      bnonce: BUS_NONCE_A,
    });
    expect(decoded?.pnonce).toBeUndefined();
  });

  it('waitFor returns immediately when events exist', async () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
    bus.emit(makeEvent(918));
    bus.emit(makeEvent(919));
    const result = await bus.waitFor({
      sinceCursor: 0,
      maxWaitMs: 1000,
      coalesceWindowMs: 0,
      maxBatchSize: 10,
    });
    expect(result.entries.length).toBe(2);
    expect(result.entries[0]!.event.type).toBe('issue-transition');
  });

  it('parseCursor: valid position within issued range (matching nonces)', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917', nonce: BUS_NONCE_A });
    bus.emit(makeEvent(918));
    const c = encodeCursor('generacy-ai/generacy#917', 1, INSTANCE_NONCE, BUS_NONCE_A);
    expect(bus.parseCursor(c)).toEqual({ kind: 'valid', position: 1 });
  });

  it('parseCursor: undefined → valid at position 0', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
    expect(bus.parseCursor(undefined)).toEqual({ kind: 'valid', position: 0 });
  });

  it('parseCursor: malformed → malformed', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
    expect(bus.parseCursor('this-is-not-base64-json').kind).toBe('malformed');
  });

  it('parseCursor: missing nonce fields → discarded/legacy', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917', nonce: BUS_NONCE_A });
    bus.emit(makeEvent(918));
    // Legacy pre-fix cursor payload — no pnonce, no bnonce.
    const legacy = Buffer.from(
      JSON.stringify({ epic: 'generacy-ai/generacy#917', position: 1 }),
      'utf-8',
    ).toString('base64');
    const parsed = bus.parseCursor(legacy);
    expect(parsed).toEqual({ kind: 'discarded', reason: 'legacy' });
  });

  it('parseCursor: mismatched pnonce → discarded/cross-instance', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917', nonce: BUS_NONCE_A });
    bus.emit(makeEvent(918));
    const c = encodeCursor('generacy-ai/generacy#917', 1, FAKE_PNONCE, BUS_NONCE_A);
    expect(bus.parseCursor(c)).toEqual({ kind: 'discarded', reason: 'cross-instance' });
  });

  it('parseCursor: mismatched bnonce (same pnonce) → discarded/evicted', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917', nonce: BUS_NONCE_A });
    bus.emit(makeEvent(918));
    const c = encodeCursor('generacy-ai/generacy#917', 1, INSTANCE_NONCE, BUS_NONCE_B);
    expect(bus.parseCursor(c)).toEqual({ kind: 'discarded', reason: 'evicted' });
  });

  it('parseCursor: same-instance same-bus out-of-range → never-issued', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917', nonce: BUS_NONCE_A });
    bus.emit(makeEvent(918));
    const c = encodeCursor('generacy-ai/generacy#917', 999, INSTANCE_NONCE, BUS_NONCE_A);
    expect(bus.parseCursor(c).kind).toBe('never-issued');
  });

  it('parseCursor: wrong-epic → wrong-epic', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917', nonce: BUS_NONCE_A });
    bus.emit(makeEvent(918));
    // wrong-epic classification runs before nonce checks; use same nonces so
    // the pnonce/bnonce branches don't shadow it.
    const c = encodeCursor('other/other#1', 1, INSTANCE_NONCE, BUS_NONCE_A);
    expect(bus.parseCursor(c).kind).toBe('wrong-epic');
  });

  it('retention: retentionCount trims old entries and cursor classifies as expired', () => {
    const bus = new EpicEventBus({
      epic: 'generacy-ai/generacy#917',
      retentionCount: 1,
      retentionMs: 60_000,
      nonce: BUS_NONCE_A,
    });
    bus.emit(makeEvent(918));
    bus.emit(makeEvent(919));
    bus.emit(makeEvent(920));
    expect(bus.size()).toBe(1);
    const c = encodeCursor('generacy-ai/generacy#917', 1, INSTANCE_NONCE, BUS_NONCE_A);
    // Caller wants events > 1; next desired is 2, but low-watermark is 3 (2 was trimmed).
    expect(bus.parseCursor(c).kind).toBe('expired');
  });

  it('retention: retentionMs trims stale entries', () => {
    let clock = 1000;
    const bus = new EpicEventBus({
      epic: 'generacy-ai/generacy#917',
      retentionCount: 100,
      retentionMs: 500,
      now: () => clock,
    });
    bus.emit(makeEvent(918));
    clock = 2000; // 1000 ms later — past the 500 ms retention.
    bus.emit(makeEvent(919));
    expect(bus.size()).toBe(1);
  });

  it('emit body is structurally-equal to a valid CockpitStreamEvent', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
    const evt = makeEvent(918);
    const entry = bus.emit(evt);
    expect(entry.event).toEqual(evt);
    // The serialized body should be the same JSON emit() would write.
    const serialized = JSON.stringify(entry.event);
    expect(serialized).toBe(JSON.stringify(evt));
  });

  it('waitFor ordering across cursor resumes', async () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
    bus.emit(makeEvent(918));
    bus.emit(makeEvent(919));
    bus.emit(makeEvent(920));
    const first = await bus.waitFor({
      sinceCursor: 0,
      maxWaitMs: 0,
      coalesceWindowMs: 0,
      maxBatchSize: 2,
    });
    expect(first.entries.map((e) => (e.event as { number?: number }).number)).toEqual([918, 919]);
    const second = await bus.waitFor({
      sinceCursor: first.entries[first.entries.length - 1]!.cursor,
      maxWaitMs: 0,
      coalesceWindowMs: 0,
      maxBatchSize: 10,
    });
    expect(second.entries.map((e) => (e.event as { number?: number }).number)).toEqual([920]);
  });
});
