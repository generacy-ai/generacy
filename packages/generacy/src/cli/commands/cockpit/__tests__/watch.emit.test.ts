import { describe, expect, it } from 'vitest';
import { emit, CockpitEventSchema } from '../watch/emit.js';
import type { CockpitEvent } from '../watch/diff.js';

function makeEvent(overrides: Partial<CockpitEvent> = {}): CockpitEvent {
  return {
    ts: '2026-06-26T12:00:00.000Z',
    repo: 'o/r',
    kind: 'issue',
    number: 1,
    from: 'pending',
    to: 'active',
    sourceLabel: 'phase:plan',
    url: 'https://github.com/o/r/issues/1',
    event: 'label-change',
    labels: ['phase:plan'],
    ...overrides,
  };
}

class CaptureStdout {
  public chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

describe('CockpitEventSchema validation', () => {
  it.each([
    'label-change',
    'issue-closed',
    'pr-merged',
    'pr-closed',
    'pr-checks',
  ] as const)('parses a valid %s event', (e) => {
    const event = makeEvent({ event: e, kind: e.startsWith('pr-') ? 'pr' : 'issue', url: 'https://github.com/o/r/pull/1' });
    if (event.kind === 'issue') event.url = 'https://github.com/o/r/issues/1';
    expect(() => CockpitEventSchema.parse(event)).not.toThrow();
  });

  it('rejects unknown event discriminator', () => {
    const event = { ...makeEvent(), event: 'invented' as unknown as 'label-change' };
    expect(() => CockpitEventSchema.parse(event)).toThrow();
  });

  it('rejects non-ISO ts', () => {
    expect(() => CockpitEventSchema.parse(makeEvent({ ts: 'tomorrow' }))).toThrow();
  });
});

describe('emit', () => {
  it('writes exactly one \\n-terminated line per call', () => {
    const stdout = new CaptureStdout();
    emit(makeEvent(), { stdout });
    expect(stdout.chunks).toHaveLength(1);
    expect(stdout.chunks[0]?.endsWith('\n')).toBe(true);
    const line = stdout.chunks[0]!.slice(0, -1);
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it('writes valid CockpitEventSchema-parseable JSON', () => {
    const stdout = new CaptureStdout();
    emit(makeEvent(), { stdout });
    const parsed = JSON.parse(stdout.chunks[0]!);
    expect(() => CockpitEventSchema.parse(parsed)).not.toThrow();
  });

  it('throws when event is invalid (defense-in-depth)', () => {
    const stdout = new CaptureStdout();
    const bad = { ...makeEvent(), kind: 'mystery' as unknown as 'issue' };
    expect(() => emit(bad, { stdout })).toThrow();
  });
});
