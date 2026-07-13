import { describe, expect, it } from 'vitest';
import {
  AggregateEventSchema,
  emitAggregate,
  type AggregateEvent,
  type PhaseCompleteEvent,
  type EpicCompleteEvent,
} from '../watch/aggregate-emit.js';

function phaseComplete(overrides: Partial<PhaseCompleteEvent> = {}): PhaseCompleteEvent {
  return {
    type: 'phase-complete',
    phase: 'P1 — Foundation',
    epicRepo: 'generacy-ai/generacy',
    epicNumber: 885,
    ts: '2026-07-09T14:23:11.041Z',
    ...overrides,
  };
}

function epicComplete(overrides: Partial<EpicCompleteEvent> = {}): EpicCompleteEvent {
  return {
    type: 'epic-complete',
    epicRepo: 'generacy-ai/generacy',
    epicNumber: 885,
    ts: '2026-07-09T14:25:03.782Z',
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

describe('AggregateEventSchema validation', () => {
  it('parses a valid phase-complete event with all required fields', () => {
    expect(() => AggregateEventSchema.parse(phaseComplete())).not.toThrow();
  });

  it('parses a valid phase-complete event with initial: true', () => {
    expect(() => AggregateEventSchema.parse(phaseComplete({ initial: true }))).not.toThrow();
  });

  it('parses a valid epic-complete event with all required fields', () => {
    expect(() => AggregateEventSchema.parse(epicComplete())).not.toThrow();
  });

  it('parses a valid epic-complete event with initial: true', () => {
    expect(() => AggregateEventSchema.parse(epicComplete({ initial: true }))).not.toThrow();
  });

  it('rejects phase-complete with empty phase string', () => {
    expect(() => AggregateEventSchema.parse(phaseComplete({ phase: '' }))).toThrow();
  });

  it('rejects phase-complete missing phase field', () => {
    const evt = { ...phaseComplete() } as Record<string, unknown>;
    delete evt['phase'];
    expect(() => AggregateEventSchema.parse(evt)).toThrow();
  });

  it('rejects epic-complete with a phase field (union discriminator)', () => {
    const bad = { ...epicComplete(), phase: 'P1 — Foundation' } as unknown as AggregateEvent;
    expect(() => AggregateEventSchema.parse(bad)).toThrow();
  });

  it('rejects epicRepo that is not owner/repo shape', () => {
    expect(() => AggregateEventSchema.parse(phaseComplete({ epicRepo: 'not-a-repo' }))).toThrow();
    expect(() => AggregateEventSchema.parse(epicComplete({ epicRepo: 'not-a-repo' }))).toThrow();
  });

  it('rejects epicNumber of 0', () => {
    expect(() => AggregateEventSchema.parse(phaseComplete({ epicNumber: 0 }))).toThrow();
  });

  it('rejects negative epicNumber', () => {
    expect(() => AggregateEventSchema.parse(phaseComplete({ epicNumber: -1 }))).toThrow();
  });

  it('rejects ts as a date-only string (must include time)', () => {
    expect(() => AggregateEventSchema.parse(phaseComplete({ ts: '2026-07-09' }))).toThrow();
  });

  it('rejects initial: false', () => {
    const bad = { ...phaseComplete(), initial: false } as unknown as AggregateEvent;
    expect(() => AggregateEventSchema.parse(bad)).toThrow();
  });
});

describe('emitAggregate', () => {
  it('writes exactly one newline-terminated JSON line', () => {
    const stdout = new CaptureStdout();
    emitAggregate(phaseComplete(), { stdout });
    expect(stdout.chunks).toHaveLength(1);
    expect(stdout.chunks[0]?.endsWith('\n')).toBe(true);
    const line = stdout.chunks[0]!.slice(0, -1);
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it('writes valid schema-parseable JSON for epic-complete', () => {
    const stdout = new CaptureStdout();
    emitAggregate(epicComplete(), { stdout });
    const parsed = JSON.parse(stdout.chunks[0]!);
    expect(() => AggregateEventSchema.parse(parsed)).not.toThrow();
  });

  it('throws when event is invalid (defense-in-depth)', () => {
    const stdout = new CaptureStdout();
    const bad = { ...phaseComplete(), phase: '' } as AggregateEvent;
    expect(() => emitAggregate(bad, { stdout })).toThrow();
  });

  it('skips validation when skipValidate is set', () => {
    const stdout = new CaptureStdout();
    const bad = { ...phaseComplete(), phase: '' } as AggregateEvent;
    expect(() => emitAggregate(bad, { stdout, skipValidate: true })).not.toThrow();
    expect(stdout.chunks).toHaveLength(1);
  });
});
