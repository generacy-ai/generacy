/**
 * `HandlerOutcome` discriminated union (#902 FR-005).
 *
 * The only legal return shape for `MergeConflictHandler.handle`. Every
 * terminal exit path in the handler maps to exactly one variant; compile-time
 * exhaustiveness enforces this at the type layer.
 *
 * The load-bearing enforcement half is the runtime helper
 * `assertHandlerOutcomeMatchesWorld` in `./handler-outcome-assertion.ts`.
 *
 * Semantics:
 *  - `re-armed` — the interrupted phase must be re-entered. Dispatcher enqueues
 *    `{command: 'continue', startPhase}` for the same itemKey after
 *    `queue.complete()` fires on the current handler item.
 *  - `gated` — the issue is now sitting at a `waiting-for:*` label matching
 *    `gateLabel`. Detector will pick it up naturally.
 *  - `failed` — the issue is now sitting at a `blocked:*` or `failed:*` marker.
 *    Operator intervention required.
 *  - `done` — the issue is terminal (closed / merged / withdrawn). No detector
 *    pickup expected.
 */
import type { WorkflowPhase } from './types.js';
import type { BlockedStuckMergeConflictsEvidence } from './merge-conflict-handler.js';

export interface ReArmedOutcome {
  readonly outcome: 're-armed';
  /** Phase the interrupted worker should resume at. Threaded to enqueue. */
  readonly startPhase: WorkflowPhase;
}

export interface GatedOutcome {
  readonly outcome: 'gated';
  /**
   * The `waiting-for:*` label that MUST be present on the issue at return.
   * Enforced by `assertHandlerOutcomeMatchesWorld`.
   */
  readonly gateLabel: string;
}

export interface FailedOutcome {
  readonly outcome: 'failed';
  /**
   * Evidence blob rendered into the operator-facing stage comment.
   * Shape is handler-specific; `MergeConflictHandler` uses
   * `BlockedStuckMergeConflictsEvidence`.
   */
  readonly evidence: BlockedStuckMergeConflictsEvidence;
}

export interface DoneOutcome {
  readonly outcome: 'done';
}

export type HandlerOutcome =
  | ReArmedOutcome
  | GatedOutcome
  | FailedOutcome
  | DoneOutcome;
