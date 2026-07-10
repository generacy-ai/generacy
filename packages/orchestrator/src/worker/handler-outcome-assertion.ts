/**
 * `assertHandlerOutcomeMatchesWorld` (#902 FR-006).
 *
 * Post-exit runtime assertion that reads a snapshot of the *real* world
 * (labels + queue state) and refuses to accept "the handler said X" as
 * evidence. Load-bearing enforcement half of the terminal-outcome invariant.
 *
 * Compile-time exhaustiveness would have passed the broken #898 handler
 * (which had a `void` return that ran through the success path without
 * setting anything). The type alone cannot catch this bug class.
 *
 * Pure function — fixture code snapshots the world, then calls the helper.
 * Callable from prod code as a dev-mode assertion (not enabled by default).
 */
import type { HandlerOutcome } from './handler-outcome.js';
import type { QueueItem } from '../types/index.js';

export interface QueueSnapshot {
  readonly inFlight: boolean;
  readonly pendingItems: readonly Pick<QueueItem, 'command' | 'metadata' | 'workflowName'>[];
}

export type AssertionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly mismatch: string };

/**
 * Assert the returned `HandlerOutcome` matches the real world.
 *
 * Rules per variant:
 *  - `re-armed`: `queueSnapshot.pendingItems` contains an entry with
 *    `command === 'continue'` and `metadata?.startPhase === outcome.startPhase`.
 *  - `gated`: `labels` contains a matching `waiting-for:*` label.
 *  - `failed`: `labels` contains a `blocked:*` or `failed:*` marker.
 *  - `done`: `labels` contains no `waiting-for:*` and no `blocked:*` / `failed:*`.
 */
export function assertHandlerOutcomeMatchesWorld(
  outcome: HandlerOutcome,
  labels: readonly string[],
  queueSnapshot: QueueSnapshot,
): AssertionResult {
  switch (outcome.outcome) {
    case 're-armed': {
      const match = queueSnapshot.pendingItems.find(
        (i) =>
          i.command === 'continue' &&
          (i.metadata as { startPhase?: string } | undefined)?.startPhase === outcome.startPhase,
      );
      if (!match) {
        return {
          ok: false,
          mismatch: `re-armed(${outcome.startPhase}): no matching pending item found in queue`,
        };
      }
      return { ok: true };
    }
    case 'gated': {
      const hasMatchingWaitingFor = labels.some(
        (l) => l === outcome.gateLabel && l.startsWith('waiting-for:'),
      );
      if (!hasMatchingWaitingFor) {
        return {
          ok: false,
          mismatch: `gated(${outcome.gateLabel}): no matching waiting-for:* label on issue`,
        };
      }
      return { ok: true };
    }
    case 'failed': {
      const hasBlockedOrFailed = labels.some(
        (l) => l.startsWith('blocked:') || l.startsWith('failed:'),
      );
      if (!hasBlockedOrFailed) {
        return {
          ok: false,
          mismatch: `failed: no blocked:* or failed:* marker on issue`,
        };
      }
      return { ok: true };
    }
    case 'done': {
      const terminalBlockers = labels.filter(
        (l) =>
          l.startsWith('waiting-for:') ||
          l.startsWith('blocked:') ||
          l.startsWith('failed:'),
      );
      if (terminalBlockers.length > 0) {
        return {
          ok: false,
          mismatch: `done: unexpected terminal-blocker label(s): ${terminalBlockers.join(', ')}`,
        };
      }
      return { ok: true };
    }
  }
}
