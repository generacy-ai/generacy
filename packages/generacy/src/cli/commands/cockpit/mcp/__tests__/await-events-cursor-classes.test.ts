import { describe, it, expect } from 'vitest';
import { cockpitAwaitEvents } from '../tools/cockpit_await_events.js';
import { EpicEventBus, encodeCursor } from '../event-bus.js';
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

function primed(): { bus: EpicEventBus; acquired: { bus: EpicEventBus; release: () => void } } {
  const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#917' });
  bus.emit(makeEvent(918));
  return { bus, acquired: { bus, release: () => undefined } };
}

describe('cockpit_await_events: cursor classes (Q3-D)', () => {
  it('malformed cursor → invalid-cursor', async () => {
    const { acquired } = primed();
    const res = await cockpitAwaitEvents(
      {
        epic: { owner: 'generacy-ai', repo: 'generacy', number: 917 },
        cursor: 'garbage-not-base64',
      },
      { acquired },
    );
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    expect(res.class).toBe('invalid-cursor');
  });

  it('never-issued cursor → invalid-cursor', async () => {
    const { acquired } = primed();
    const c = encodeCursor('generacy-ai/generacy#917', 9999);
    const res = await cockpitAwaitEvents(
      {
        epic: { owner: 'generacy-ai', repo: 'generacy', number: 917 },
        cursor: c,
      },
      { acquired },
    );
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    expect(res.class).toBe('invalid-cursor');
  });

  it('wrong-epic cursor → invalid-cursor', async () => {
    const { acquired } = primed();
    const c = encodeCursor('other/other#1', 1);
    const res = await cockpitAwaitEvents(
      {
        epic: { owner: 'generacy-ai', repo: 'generacy', number: 917 },
        cursor: c,
      },
      { acquired },
    );
    expect(res.status).toBe('error');
    if (res.status !== 'error') return;
    expect(res.class).toBe('invalid-cursor');
  });

  it('expired cursor → silent reset with resetFrom: "expired"', async () => {
    const bus = new EpicEventBus({
      epic: 'generacy-ai/generacy#917',
      retentionCount: 1,
    });
    bus.emit(makeEvent(918));
    bus.emit(makeEvent(919));
    bus.emit(makeEvent(920));
    const oldCursor = encodeCursor('generacy-ai/generacy#917', 1);
    const res = await cockpitAwaitEvents(
      {
        epic: { owner: 'generacy-ai', repo: 'generacy', number: 917 },
        cursor: oldCursor,
        maxWaitMs: 100,
        coalesceWindowMs: 0,
      },
      { acquired: { bus, release: () => undefined } },
    );
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.data.resetFrom).toBe('expired');
    expect(res.data.events.length).toBeGreaterThan(0);
  });
});
