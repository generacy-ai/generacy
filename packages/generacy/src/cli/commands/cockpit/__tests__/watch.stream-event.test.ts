import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { CockpitStreamEventSchema } from '../watch/stream-event.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const COCKPIT_DIR = resolve(HERE, '..');
const README_PATH = resolve(HERE, '../../../../../README.md');

type Fixture = { name: string; line: unknown };

const issueTransitionEvents = [
  'label-change',
  'issue-closed',
  'pr-merged',
  'pr-closed',
  'pr-checks',
] as const;

function baseIssueTransition(
  event: (typeof issueTransitionEvents)[number],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const isPr = event.startsWith('pr-');
  return {
    type: 'issue-transition',
    ts: '2026-07-09T14:20:03.111Z',
    repo: 'o/r',
    kind: isPr ? 'pr' : 'issue',
    number: 123,
    from: 'pending',
    to: 'active',
    sourceLabel: 'phase:plan',
    url: isPr ? 'https://github.com/o/r/pull/123' : 'https://github.com/o/r/issues/123',
    event,
    labels: ['phase:plan'],
    ...overrides,
  };
}

function basePhaseComplete(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'phase-complete',
    phase: 'P1 — Foundation',
    epicRepo: 'generacy-ai/generacy',
    epicNumber: 885,
    ts: '2026-07-09T14:23:11.041Z',
    ...overrides,
  };
}

function baseEpicComplete(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'epic-complete',
    epicRepo: 'generacy-ai/generacy',
    epicNumber: 885,
    ts: '2026-07-09T14:25:03.782Z',
    ...overrides,
  };
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      walk(full, out);
    } else if (st.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('CockpitStreamEventSchema — fixture set (path-exhaustive)', () => {
  const fixtures: Fixture[] = [];
  for (const evt of issueTransitionEvents) {
    fixtures.push({ name: `issue-transition/${evt}`, line: baseIssueTransition(evt) });
    fixtures.push({
      name: `issue-transition/${evt} initial:true`,
      line: baseIssueTransition(evt, { from: null, initial: true }),
    });
  }
  fixtures.push({ name: 'phase-complete', line: basePhaseComplete() });
  fixtures.push({ name: 'phase-complete initial:true', line: basePhaseComplete({ initial: true }) });
  fixtures.push({ name: 'epic-complete', line: baseEpicComplete() });
  fixtures.push({ name: 'epic-complete initial:true', line: baseEpicComplete({ initial: true }) });

  it.each(fixtures)('parses $name', ({ line }) => {
    expect(() => CockpitStreamEventSchema.parse(line)).not.toThrow();
  });
});

describe('CockpitStreamEventSchema — lint-style caller enumeration', () => {
  it('emit() and emitAggregate() call sites match the pinned allow-list', () => {
    const allowList = new Set(
      [
        'watch/emit.ts',
        'watch/aggregate-emit.ts',
        'watch.ts',
        // MCP stdio transport (#917) — replays the same event source into an
        // in-process event bus for `cockpit_await_events`. Bus-side emit is a
        // method, not stdout NDJSON, but the regex still matches.
        'mcp/event-bus.ts',
        'mcp/event-bus-registry.ts',
        // Answers-file tailer (#1023) — the doorbell bridges gate-answer
        // events into the shared bus so `cockpit_await_events` sees them.
        // `busForTailer.emit(event)` is a method call, not stdout NDJSON.
        'doorbell.ts',
      ].map((rel) => resolve(COCKPIT_DIR, rel)),
    );
    const found = new Set<string>();
    for (const file of walk(COCKPIT_DIR)) {
      const src = readFileSync(file, 'utf8');
      if (/\bemit\(|\bemitAggregate\(/.test(src)) {
        found.add(file);
      }
    }
    const foundSorted = [...found].sort();
    const allowSorted = [...allowList].sort();
    expect(foundSorted).toEqual(allowSorted);
  });
});

describe('CockpitStreamEventSchema — README drift check', () => {
  it('README stream-grammar type set matches CockpitStreamEventSchema discriminator values', () => {
    const readme = readFileSync(README_PATH, 'utf8');
    const rowRegex = /^\|\s*`([^`]+)`\s*\|[^\n]*\|[^\n]*\|/gm;
    const readmeTypes = new Set<string>();
    for (const match of readme.matchAll(rowRegex)) {
      const cell = match[1];
      if (
        cell === 'issue-transition' ||
        cell === 'phase-complete' ||
        cell === 'epic-complete' ||
        cell === 'gate-answer'
      ) {
        readmeTypes.add(cell);
      }
    }
    const options = (CockpitStreamEventSchema as unknown as {
      _def: { options: Array<{ shape: { type: { value: string } } }> };
    })._def.options;
    const schemaTypes = new Set(options.map((o) => o.shape.type.value));
    expect(readmeTypes).toEqual(schemaTypes);
    expect(schemaTypes.size).toBe(4);
  });
});

describe('CockpitStreamEventSchema — back-compat fixture stream', () => {
  const stream: Array<Record<string, unknown>> = [
    baseIssueTransition('label-change'),
    baseIssueTransition('issue-closed', { to: 'terminal' }),
    baseIssueTransition('pr-merged', { to: 'terminal' }),
    baseIssueTransition('pr-closed', { to: 'terminal' }),
    baseIssueTransition('pr-checks'),
    basePhaseComplete(),
    baseEpicComplete(),
  ];

  it('dispatching on type sees 100% of lines', () => {
    let seen = 0;
    for (const raw of stream) {
      const evt = CockpitStreamEventSchema.parse(raw);
      switch (evt.type) {
        case 'issue-transition':
        case 'phase-complete':
        case 'epic-complete':
          seen++;
          break;
      }
    }
    expect(seen).toBe(stream.length);
  });

  it('filtering by event still sees every per-issue line unchanged', () => {
    const perIssueLines = stream.filter((raw) => raw.type === 'issue-transition');
    const withEvent = perIssueLines.filter((raw) => typeof raw.event === 'string');
    expect(withEvent.length).toBe(perIssueLines.length);
    const events = perIssueLines.map((raw) => raw.event);
    expect(events).toEqual([
      'label-change',
      'issue-closed',
      'pr-merged',
      'pr-closed',
      'pr-checks',
    ]);
  });
});
