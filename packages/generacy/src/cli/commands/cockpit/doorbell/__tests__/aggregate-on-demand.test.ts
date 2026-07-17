import { describe, expect, it, vi } from 'vitest';
import { maybeRefreshAggregate } from '../aggregate-on-demand.js';
import { initialAggregateState } from '../../watch/aggregate.js';
import type { GhWrapper } from '@generacy-ai/cockpit';

const nowIso = (): string => '2026-07-17T00:00:00.000Z';

describe('maybeRefreshAggregate — null trigger short-circuit', () => {
  it('trigger=null returns identity output with zero I/O', async () => {
    const prevAgg = initialAggregateState();
    const prev = new Map();
    const gh = {} as unknown as GhWrapper;
    const warn = vi.fn();
    const result = await maybeRefreshAggregate({
      trigger: null,
      epicRef: 'o/r#100',
      epicRepo: 'o/r',
      epicNumber: 100,
      prevAgg,
      prev,
      currentResolved: null,
      gh,
      logger: { warn },
      now: nowIso,
    });
    expect(result.events).toEqual([]);
    expect(result.nextAgg).toBe(prevAgg);
    expect(result.nextPrev).toBe(prev);
    expect(result.nextResolved).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('trigger=null with prior resolved is preserved', async () => {
    const prevAgg = initialAggregateState();
    const prev = new Map();
    const gh = {} as unknown as GhWrapper;
    const currentResolved = {
      epic: { repo: 'o/r', number: 100 },
      parsed: { phases: [], adhocRefs: [], allRefs: [], warnings: [] },
      repos: ['o/r'],
      bodyHash: 'x',
    };
    const warn = vi.fn();
    const result = await maybeRefreshAggregate({
      trigger: null,
      epicRef: 'o/r#100',
      epicRepo: 'o/r',
      epicNumber: 100,
      prevAgg,
      prev,
      currentResolved,
      gh,
      logger: { warn },
      now: nowIso,
    });
    expect(result.nextResolved).toBe(currentResolved);
    expect(warn).not.toHaveBeenCalled();
  });
});
