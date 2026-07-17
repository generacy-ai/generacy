import { describe, expect, it } from 'vitest';
import { EpicEventBus } from '../mcp/event-bus.js';
import { lineForEvent, subscribeAndEmit } from '../doorbell/subscribe.js';
import type { CockpitStreamEvent } from '../watch/stream-event.js';
import { CockpitStreamEventSchema } from '../watch/stream-event.js';

function makeIssueTransition(number: number): CockpitStreamEvent {
  return {
    type: 'issue-transition',
    ts: '2026-07-11T00:00:00.000Z',
    repo: 'generacy-ai/generacy',
    kind: 'issue',
    number,
    from: null,
    to: 'waiting',
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

describe('lineForEvent — NDJSON line shape (T007, FR-001, INV-3)', () => {
  function parseAndValidate(line: string): CockpitStreamEvent {
    expect(line.endsWith('\n')).toBe(true);
    // Exactly one trailing '\n' — no extra whitespace before it.
    expect(line.slice(0, -1)).not.toMatch(/\n/);
    const parsed = JSON.parse(line.slice(0, -1));
    return CockpitStreamEventSchema.parse(parsed) as CockpitStreamEvent;
  }

  it('issue-transition serializes as valid NDJSON and parses back through the schema', () => {
    const ev = makeIssueTransition(1);
    const line = lineForEvent(ev);
    const back = parseAndValidate(line);
    expect(back.type).toBe('issue-transition');
    if (back.type === 'issue-transition') {
      expect(back.repo).toBe('generacy-ai/generacy');
      expect(back.number).toBe(1);
      expect(back.to).toBe('waiting');
    }
  });

  it('phase-complete serializes as valid NDJSON and parses back through the schema', () => {
    const ev = makePhaseComplete();
    const line = lineForEvent(ev);
    const back = parseAndValidate(line);
    expect(back.type).toBe('phase-complete');
  });

  it('epic-complete serializes as valid NDJSON and parses back through the schema', () => {
    const ev = makeEpicComplete();
    const line = lineForEvent(ev);
    const back = parseAndValidate(line);
    expect(back.type).toBe('epic-complete');
  });

  it('emits a single trailing newline and no blank lines', () => {
    const line = lineForEvent(makeIssueTransition(1));
    expect(line.match(/\n/g)?.length).toBe(1);
    expect(line.trim().length).toBeGreaterThan(0);
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

    expect(stdout.writes).toHaveLength(3);
    const types = stdout.writes.map((line) => {
      expect(line.endsWith('\n')).toBe(true);
      return (JSON.parse(line.slice(0, -1)) as { type: string }).type;
    });
    expect(types).toEqual(['issue-transition', 'phase-complete', 'epic-complete']);
    unsubscribe();
  });

  it('T11 — unsubscribe stops further writes mid-loop (FR-007 invariant)', async () => {
    const bus = new EpicEventBus({ epic: 'generacy-ai/generacy#100' });
    const stdout = makeStdout();
    const unsubscribe = subscribeAndEmit(bus, { stdout });

    bus.emit(makeIssueTransition(1));
    await flush();
    expect(stdout.writes).toHaveLength(1);
    expect((JSON.parse(stdout.writes[0]!.slice(0, -1)) as { type: string }).type).toBe(
      'issue-transition',
    );

    unsubscribe();

    bus.emit(makeIssueTransition(2));
    bus.emit(makeIssueTransition(3));
    await flush();

    expect(stdout.writes).toHaveLength(1);
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
