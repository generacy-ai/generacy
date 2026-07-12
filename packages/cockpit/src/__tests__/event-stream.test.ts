import { describe, expect, it } from 'vitest';
import { classify } from '../state/classifier.js';

/**
 * Event-plane tests for #926.
 *
 * The `issue-transition` event is emitted by the cockpit watch diff engine
 * (packages/generacy/.../watch/diff.ts `computeTransitions`) whenever the
 * classifier's `sourceLabel` changes across two consecutive label-set
 * snapshots. These tests pin the classifier-side invariant: the add and
 * remove edges of `waiting-for:address-pr-feedback` each flip `sourceLabel`
 * exactly once, which is the necessary and sufficient condition for the
 * diff engine to emit exactly one event per edge (SC-002, FR-003, FR-004).
 *
 * FR-011 out-of-scope guard: the classify() return shape is
 * `{ state, sourceLabel }` — unchanged by this fix. Any expansion of the
 * shape would break every test in this file.
 */
describe('event-stream: waiting-for:address-pr-feedback transitions (#926)', () => {
  it('add edge: {implementation-review} → {implementation-review, address-pr-feedback} flips sourceLabel exactly once (SC-002, FR-003)', () => {
    const prev = classify(['waiting-for:implementation-review']);
    const curr = classify(['waiting-for:implementation-review', 'waiting-for:address-pr-feedback']);

    // Pre-condition: prev is the passive gate.
    expect(prev).toEqual({
      state: 'waiting',
      sourceLabel: 'waiting-for:implementation-review',
    });

    // Post-condition: curr is the active state — one sourceLabel flip.
    expect(curr).toEqual({
      state: 'waiting',
      sourceLabel: 'waiting-for:address-pr-feedback',
    });

    // Invariant tested by this pair: the diff engine sees one and only one
    // sourceLabel change → emits exactly one `issue-transition` event with
    // `to = waiting-for:address-pr-feedback`. Same tier (`waiting`), so
    // the state field does not flip — only sourceLabel does.
    expect(prev.sourceLabel).not.toBe(curr.sourceLabel);
    expect(prev.state).toBe(curr.state);
  });

  it('remove edge: {implementation-review, address-pr-feedback} → {implementation-review} flips sourceLabel exactly once (SC-002, FR-004)', () => {
    const prev = classify(['waiting-for:implementation-review', 'waiting-for:address-pr-feedback']);
    const curr = classify(['waiting-for:implementation-review']);

    // Pre-condition: prev is the active state.
    expect(prev).toEqual({
      state: 'waiting',
      sourceLabel: 'waiting-for:address-pr-feedback',
    });

    // Post-condition: curr reverts to the passive gate.
    expect(curr).toEqual({
      state: 'waiting',
      sourceLabel: 'waiting-for:implementation-review',
    });

    // Invariant: one sourceLabel flip → exactly one `issue-transition`
    // event with `to = waiting-for:implementation-review`. This is the
    // auto re-review signal that D.3/D.4 pick up (SC-003).
    expect(prev.sourceLabel).not.toBe(curr.sourceLabel);
    expect(prev.state).toBe(curr.state);
  });

  it('round-trip: engage → complete emits two distinct sourceLabel snapshots in order', () => {
    // The full loop the auto-mode session observes: start at implementation
    // review, the server-side handler enqueues `address-pr-feedback`, works,
    // then removes the label. Consumer should see exactly two transitions.
    const snapshots = [
      classify(['waiting-for:implementation-review']),
      classify(['waiting-for:implementation-review', 'waiting-for:address-pr-feedback']),
      classify(['waiting-for:implementation-review']),
    ];

    const sourceLabels = snapshots.map(s => s.sourceLabel);
    expect(sourceLabels).toEqual([
      'waiting-for:implementation-review',
      'waiting-for:address-pr-feedback',
      'waiting-for:implementation-review',
    ]);

    // Each consecutive pair flips → the diff engine emits exactly two
    // `issue-transition` events across the full round-trip.
    const transitions = snapshots
      .slice(1)
      .map((curr, i) => ({ from: snapshots[i]!.sourceLabel, to: curr.sourceLabel }))
      .filter(t => t.from !== t.to);
    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toEqual({
      from: 'waiting-for:implementation-review',
      to: 'waiting-for:address-pr-feedback',
    });
    expect(transitions[1]).toEqual({
      from: 'waiting-for:address-pr-feedback',
      to: 'waiting-for:implementation-review',
    });
  });

  it('FR-011 payload shape guard: classify() returns { state, sourceLabel } only', () => {
    // Any expansion of the classify() return shape trips this test — the
    // wire shape of `issue-transition` events is downstream of this shape,
    // so pinning it here catches an accidental FR-011 violation.
    const result = classify(['waiting-for:address-pr-feedback']);
    expect(Object.keys(result).sort()).toEqual(['sourceLabel', 'state']);
  });
});
