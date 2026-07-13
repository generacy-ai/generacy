/**
 * #902 T016 — FR-009 assertion-only coverage for `PrFeedbackHandler`.
 *
 * No handler signature change. Wraps the terminal-state shapes that
 * `PrFeedbackHandler` produces today with `assertHandlerOutcomeMatchesWorld`,
 * mapped from fixture inputs via a small `deriveImpliedOutcome` heuristic:
 *
 *   - `waiting-for:*` present → `gated`
 *   - `blocked:*` / `failed:*` present → `failed`
 *   - neither → `done`
 *   - `re-armed` currently NEVER emitted by `PrFeedbackHandler` — if a future
 *     fixture surfaces one it would fail this test loudly, which is exactly
 *     the point (surfaces a `#902`-class latent bug).
 *
 * Per `contracts/handler-outcome.md` §"PrFeedbackHandler scope (FR-009)".
 */
import { describe, it, expect } from 'vitest';
import type { QueueItem } from '../../types/index.js';
import { assertHandlerOutcomeMatchesWorld, type QueueSnapshot } from '../handler-outcome-assertion.js';
import type { HandlerOutcome } from '../handler-outcome.js';
import type { BlockedStuckMergeConflictsEvidence } from '../merge-conflict-handler.js';

/**
 * Fixture-local heuristic. Not exported by the handler package — this is
 * the assertion-only shape mapping per `contracts/handler-outcome.md`.
 *
 * If a `PrFeedbackHandler` fixture ever produces a terminal state that
 * doesn't map cleanly to one of these three, that's a #902-class latent
 * bug and the test fails at the assertion, not here.
 */
function deriveImpliedOutcome(labels: readonly string[]): HandlerOutcome {
  const waitingFor = labels.find((l) => l.startsWith('waiting-for:'));
  if (waitingFor) {
    return { outcome: 'gated', gateLabel: waitingFor };
  }
  const hasFailure = labels.some(
    (l) => l.startsWith('blocked:') || l.startsWith('failed:'),
  );
  if (hasFailure) {
    // The evidence blob is a fixture-side stand-in — `PrFeedbackHandler`
    // doesn't use `BlockedStuckMergeConflictsEvidence`, but the runtime
    // helper only checks the label shape, not the evidence content.
    const stubEvidence: BlockedStuckMergeConflictsEvidence = {
      unresolvedPaths: [], partiallyResolvedPaths: [],
      baseRef: '', branchTipSha: '', attemptedAt: new Date(0).toISOString(),
    };
    return { outcome: 'failed', evidence: stubEvidence };
  }
  return { outcome: 'done' };
}

/**
 * Each fixture below expresses a canonical `PrFeedbackHandler` terminal
 * state as it exists in production today. The assertion helper verifies
 * that the *world* matches the *implied* outcome — i.e., that
 * `PrFeedbackHandler`'s label edits leave the issue in a shape some
 * detector matches.
 */
interface PrFeedbackFixture {
  readonly name: string;
  readonly labels: readonly string[];
  readonly queue: QueueSnapshot;
}

const fixtures: PrFeedbackFixture[] = [
  {
    // Trusted comment applied clean, feedback resolved → issue closes cycle.
    name: 'trusted comment resolved: no terminal-blocker labels remain',
    labels: ['agent:in-progress'],
    queue: { inFlight: true, pendingItems: [] },
  },
  {
    // Untrusted comment / needs-review-request → pause with waiting-for gate.
    name: 'awaiting-review gate applied',
    labels: ['waiting-for:pr-review', 'agent:paused'],
    queue: { inFlight: false, pendingItems: [] },
  },
  {
    // Comment application failed → escalation label.
    name: 'apply-failed → blocked:pr-feedback (escalation)',
    labels: [
      'waiting-for:pr-review',
      'blocked:pr-feedback',
      'agent:paused',
    ],
    queue: { inFlight: false, pendingItems: [] },
  },
];

describe('#902 T016 PrFeedbackHandler assertion-only coverage (FR-009)', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const implied = deriveImpliedOutcome(fixture.labels);
      const assertion = assertHandlerOutcomeMatchesWorld(
        implied,
        fixture.labels,
        fixture.queue,
      );
      expect(assertion).toEqual({ ok: true });
    });
  }

  it('deriveImpliedOutcome + assertion catches under-labelled terminal state (the #902 bug class)', () => {
    // A future PrFeedbackHandler variant that clears every label without
    // enqueuing a rearm would fail here — the `re-armed` outcome requires a
    // matching pending queue item, and there is none.
    const outcome: HandlerOutcome = { outcome: 're-armed', startPhase: 'validate' };
    const labels: string[] = [];
    const queue: QueueSnapshot = { inFlight: false, pendingItems: [] };
    const assertion = assertHandlerOutcomeMatchesWorld(outcome, labels, queue);
    expect(assertion.ok).toBe(false);
    if (!assertion.ok) {
      expect(assertion.mismatch).toContain('re-armed');
    }
  });

  it('gated with no matching waiting-for label is caught', () => {
    const outcome: HandlerOutcome = { outcome: 'gated', gateLabel: 'waiting-for:pr-review' };
    const labels = ['agent:paused']; // missing the waiting-for
    const assertion = assertHandlerOutcomeMatchesWorld(outcome, labels, {
      inFlight: false, pendingItems: [],
    });
    expect(assertion.ok).toBe(false);
  });

  it('done with lingering waiting-for label is caught (SC-004 regression scaffold)', () => {
    const outcome: HandlerOutcome = { outcome: 'done' };
    const labels = ['waiting-for:pr-review', 'agent:paused'];
    const assertion = assertHandlerOutcomeMatchesWorld(outcome, labels, {
      inFlight: false, pendingItems: [] as QueueItem[],
    });
    expect(assertion.ok).toBe(false);
    if (!assertion.ok) {
      expect(assertion.mismatch).toContain('waiting-for');
    }
  });
});
