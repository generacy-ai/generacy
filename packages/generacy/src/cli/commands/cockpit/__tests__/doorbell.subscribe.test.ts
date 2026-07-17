import { describe, expect, it } from 'vitest';
import { EpicEventBus } from '../mcp/event-bus.js';
import { lineForEvent, subscribeAndEmit } from '../doorbell/subscribe.js';
import type { CockpitStreamEvent } from '../watch/stream-event.js';

function makeIssueTransition(number: number): CockpitStreamEvent {
  return {
    type: 'issue-transition',
    ts: '2026-07-11T00:00:00.000Z',
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

function makePhaseComplete(): CockpitStreamEvent {
  return {
    type: 'phase-complete',
    phase: 'clarify',
    epicRepo: 'generacy-ai/generacy',
    epicNumber: 100,
    ts: '2026-07-11T00:00:00.000Z',
  };
}

function makeEpicComplete(): CockpitStreamEvent {
  return {
    type: 'epic-complete',
    epicRepo: 'generacy-ai/generacy',
    epicNumber: 100,
    ts: '2026-07-11T00:00:00.000Z',
  };
}

interface FakeStdout {
  writes: string[];
  write(chunk: string, cb?: () => void): boolean;
}

function makeStdout(): FakeStdout {
  return {
    writes: [],
    write(chunk: string, cb?: () => void): boolean {
      this.writes.push(chunk);
      if (cb) cb();
      return true;
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe('lineForEvent (T10 — FR-005, Q3=B)', () => {
  it('translates issue-transition to bare type word', () => {
    expect(lineForEvent(makeIssueTransition(1))).toBe('issue-transition\n');
  });

  it('translates phase-complete to bare type word', () => {
    expect(lineForEvent(makePhaseComplete())).toBe('phase-complete\n');
  });

  it('translates epic-complete to bare type word', () => {
    expect(lineForEvent(makeEpicComplete())).toBe('epic-complete\n');
  });

  it('emits no JSON, no ref, no trailing whitespace before newline', () => {
    const out = lineForEvent(makeIssueTransition(1));
    expect(out).toBe('issue-transition\n');
    expect(out).not.toContain('{');
    expect(out).not.toContain('generacy');
    expect(out.slice(0, -1)).not.toMatch(/\s$/);
  });
});

describe('subscribeAndEmit', () => {
  it('T9 — emits one stdout write per bus.emit, correct order and content (SC-003)', async () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#100' });
    const stdout = makeStdout();
    const unsubscribe = subscribeAndEmit(bus, { stdout });

    bus.emit(makeIssueTransition(1));
    bus.emit(makePhaseComplete());
    bus.emit(makeEpicComplete());

    await flush();

    expect(stdout.writes).toEqual([
      'issue-transition\n',
      'phase-complete\n',
      'epic-complete\n',
    ]);
    unsubscribe();
  });

  it('T11 — unsubscribe stops further writes mid-loop (FR-007 invariant)', async () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#100' });
    const stdout = makeStdout();
    const unsubscribe = subscribeAndEmit(bus, { stdout });

    bus.emit(makeIssueTransition(1));
    await flush();
    expect(stdout.writes).toEqual(['issue-transition\n']);

    unsubscribe();

    bus.emit(makeIssueTransition(2));
    bus.emit(makeIssueTransition(3));
    await flush();

    expect(stdout.writes).toEqual(['issue-transition\n']);
  });

  it('onEmit hook fires exactly once per emitted event, after the stdout drain', async () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#100' });
    const stdout = makeStdout();
    const seen: string[] = [];
    const drainedAt: number[] = [];
    const unsubscribe = subscribeAndEmit(bus, {
      stdout,
      onEmit: (event) => {
        seen.push(event.type);
        drainedAt.push(stdout.writes.length);
      },
    });

    bus.emit(makeIssueTransition(1));
    bus.emit(makePhaseComplete());
    await flush();

    expect(seen).toEqual(['issue-transition', 'phase-complete']);
    expect(drainedAt).toEqual([1, 2]);
    unsubscribe();
  });

  it('unsubscribe is idempotent', async () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#100' });
    const stdout = makeStdout();
    const unsubscribe = subscribeAndEmit(bus, { stdout });
    unsubscribe();
    expect(() => unsubscribe()).not.toThrow();
  });
});
