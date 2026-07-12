import { describe, expect, it } from 'vitest';
import { classify } from '../state/classifier.js';

/**
 * End-to-end fixture for #926 (SC-003, tasks T012).
 *
 * Drives the full server-side sequence a `cockpit_await_events` / `watch`
 * consumer observes across the address-PR-feedback loop:
 *
 *   1. Seed: `{waiting-for:implementation-review, agent:paused}`
 *   2. Server-side loop enqueues `waiting-for:address-pr-feedback`
 *      (`agent:in-progress` also written as the handler runs).
 *   3. Handler completes (happy path): coalesced remove of
 *      `waiting-for:address-pr-feedback` + `agent:in-progress` in a single
 *      call. Consumer must see exactly one transition per edge, ending in
 *      `waiting-for:implementation-review` — the auto re-review trigger.
 *
 * The event-emission rule the cockpit watch diff engine implements
 * (`packages/generacy/.../watch/diff.ts computeTransitions`) is:
 * a transition fires exactly when the classifier's `sourceLabel` changes
 * between two consecutive label-set snapshots. This test models that rule
 * inline so the fixture is self-contained inside `packages/cockpit`.
 */

interface TransitionEvent {
  from: string;
  to: string;
  fromState: string;
  toState: string;
}

/**
 * Minimal reproduction of the diff-engine rule used by `computeTransitions`
 * in `packages/generacy/.../watch/diff.ts`. Given consecutive label-set
 * snapshots, emit a transition each time `sourceLabel` changes.
 */
function simulateEventStream(labelSetsOverTime: string[][]): TransitionEvent[] {
  const events: TransitionEvent[] = [];
  const classifications = labelSetsOverTime.map(labels => classify(labels));
  for (let i = 1; i < classifications.length; i += 1) {
    const prev = classifications[i - 1]!;
    const curr = classifications[i]!;
    if (prev.sourceLabel !== curr.sourceLabel) {
      events.push({
        from: prev.sourceLabel,
        to: curr.sourceLabel,
        fromState: prev.state,
        toState: curr.state,
      });
    }
  }
  return events;
}

describe('E2E fixture: address-pr-feedback loop (#926 SC-003, T012)', () => {
  it('drives the full sequence and asserts consumer sees engage + complete transitions in order', () => {
    // Simulated timeline of label-set snapshots as the server-side loop runs.
    const timeline: string[][] = [
      // (1) Seed: fresh gate at implementation review, worker paused.
      ['waiting-for:implementation-review', 'agent:paused'],
      // (2) Server-side loop dispatches to `pr-feedback-handler`: adds
      //     `waiting-for:address-pr-feedback` + marks worker in-progress.
      ['waiting-for:implementation-review', 'agent:paused', 'waiting-for:address-pr-feedback', 'agent:in-progress'],
      // (3) Handler completes (happy path): coalesced clear of BOTH
      //     `waiting-for:address-pr-feedback` and `agent:in-progress` in a
      //     single `removeLabels` request. `agent:paused` re-applied by the
      //     phase-loop backstop so the fresh D.3-ready gate is intact.
      ['waiting-for:implementation-review', 'agent:paused'],
    ];

    const events = simulateEventStream(timeline);

    // SC-003: consumer receives exactly two `issue-transition` events across
    // the full round-trip — engage edge and complete edge.
    expect(events).toHaveLength(2);

    // Engage edge (FR-003, SC-002): `to = waiting-for:address-pr-feedback`.
    expect(events[0]).toEqual({
      from: 'waiting-for:implementation-review',
      to: 'waiting-for:address-pr-feedback',
      fromState: 'waiting',
      toState: 'waiting',
    });

    // Complete edge (FR-004, SC-002, SC-003 — auto re-review trigger):
    // `to = waiting-for:implementation-review`.
    expect(events[1]).toEqual({
      from: 'waiting-for:address-pr-feedback',
      to: 'waiting-for:implementation-review',
      fromState: 'waiting',
      toState: 'waiting',
    });
  });

  it('intermediate coalesced-remove race window: seeing the two-label removal as one snapshot still emits exactly one complete-edge event', () => {
    // Confirm the FR-006 coalescing produces the right consumer-visible
    // behavior. Even if a consumer polls fast enough to catch a hypothetical
    // "waiting-for gone but in-progress still present" intermediate snapshot,
    // the sourceLabel-change rule collapses the sequence back to one event.
    const timeline: string[][] = [
      ['waiting-for:implementation-review', 'agent:paused', 'waiting-for:address-pr-feedback', 'agent:in-progress'],
      // Intermediate: waiting-for gone, agent:in-progress still present (only
      // possible if the coalesced call is split — which it MUST NOT be per
      // FR-006. This test proves the classifier still emits the correct
      // downstream event regardless.)
      ['waiting-for:implementation-review', 'agent:paused', 'agent:in-progress'],
      ['waiting-for:implementation-review', 'agent:paused'],
    ];

    const events = simulateEventStream(timeline);

    // Only one sourceLabel flip: `address-pr-feedback` → `implementation-review`.
    // The `agent:in-progress` removal in step 3 doesn't change sourceLabel
    // (still `implementation-review`), so no extra event fires.
    expect(events).toHaveLength(1);
    expect(events[0]?.to).toBe('waiting-for:implementation-review');
  });

  it('blocked-stuck disposition: `blocked:stuck-feedback-loop` outranks address-pr-feedback and produces the correct engage sequence', () => {
    // Sanity for the interaction with the blocked-stuck disposition (#883).
    // When the handler gives up and adds `blocked:stuck-feedback-loop`,
    // the consumer sees a transition to the blocked state, not
    // `address-pr-feedback`.
    const timeline: string[][] = [
      ['waiting-for:implementation-review', 'agent:paused'],
      ['waiting-for:implementation-review', 'agent:paused', 'waiting-for:address-pr-feedback', 'agent:in-progress'],
      // Handler gives up: adds blocked-stuck; retains address-pr-feedback by
      // design; `finally` clears `agent:in-progress`.
      ['waiting-for:implementation-review', 'agent:paused', 'waiting-for:address-pr-feedback', 'blocked:stuck-feedback-loop'],
    ];

    const events = simulateEventStream(timeline);

    // Engage: implementation-review → address-pr-feedback (index 6 → index 1).
    // Blocked: address-pr-feedback → blocked:stuck-feedback-loop (index 1 → 0).
    expect(events).toHaveLength(2);
    expect(events[0]?.to).toBe('waiting-for:address-pr-feedback');
    expect(events[1]?.to).toBe('blocked:stuck-feedback-loop');
  });
});
