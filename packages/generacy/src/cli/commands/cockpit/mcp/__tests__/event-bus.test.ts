import { describe, it, expect } from 'vitest';
import { EpicEventBus, encodeCursor, decodeCursor } from '../event-bus.js';
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

describe('EpicEventBus', () => {
  it('assigns monotonically-increasing cursors from 1', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
    const a = bus.emit(makeEvent(918));
    const b = bus.emit(makeEvent(919));
    expect(a.cursor).toBe(1);
    expect(b.cursor).toBe(2);
  });

  it('encodes/decodes cursor round-trip', () => {
    const s = encodeCursor('generacy-ai/generacy#917', 42);
    const decoded = decodeCursor(s);
    expect(decoded).toEqual({ epic: 'generacy-ai/generacy#917', position: 42 });
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

  it('parseCursor: valid position within issued range', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
    bus.emit(makeEvent(918));
    const c = encodeCursor('generacy-ai/generacy#917', 1);
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

  it('parseCursor: never-issued → never-issued', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
    bus.emit(makeEvent(918));
    const c = encodeCursor('generacy-ai/generacy#917', 999);
    expect(bus.parseCursor(c).kind).toBe('never-issued');
  });

  it('parseCursor: wrong-epic → wrong-epic', () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
    bus.emit(makeEvent(918));
    const c = encodeCursor('other/other#1', 1);
    expect(bus.parseCursor(c).kind).toBe('wrong-epic');
  });

  it('retention: retentionCount trims old entries', () => {
    const bus = new EpicEventBus({
      epic: 'generacy-ai/generacy#917',
      retentionCount: 1,
      retentionMs: 60_000,
    });
    bus.emit(makeEvent(918));
    bus.emit(makeEvent(919));
    bus.emit(makeEvent(920));
    expect(bus.size()).toBe(1);
    const c = encodeCursor('generacy-ai/generacy#917', 1);
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
