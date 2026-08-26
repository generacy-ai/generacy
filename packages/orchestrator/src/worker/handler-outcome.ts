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

/**
 * The `base..head` window a resolution-scoped review must inspect (#1131).
 *
 * `baseSha` = pre-merge branch tip (first parent of the `--no-ff` merge commit,
 * `HEAD^1`); `headSha` = the merge commit that resolved the conflict (`HEAD`).
 * Both are the short form produced by `git rev-parse --short`. Carried on the
 * re-armed outcome and threaded to `WorkerContext.reviewScope` — never persisted
 * beyond the queue item, and NOT stored in the pause-context sidecar (which is
 * cleared immediately after re-arm).
 */
export interface ReviewScope {
  readonly baseSha: string;
  readonly headSha: string;
  /**
   * FR-003 (#1164) — conflicted file paths captured at resolution time
   * (`git diff --name-only --diff-filter=U`). When present, the scoped review is
   * restricted to this allowlist instead of the raw `baseSha..headSha` parent-1
   * diff, excluding changes that came only from the merged-in base branch. Absent
   * on non-merge-conflict scopes and on no-op / clean-merge success paths.
   */
  readonly conflictedPaths?: readonly string[];
}

export interface ReArmedOutcome {
  readonly outcome: 're-armed';
  /** Phase the interrupted worker should resume at. Threaded to enqueue. */
  readonly startPhase: WorkflowPhase;
  /**
   * Present only on the flag-ON merge-conflict success re-arm (#1131). Bounds
   * the resolution-scoped review to `baseSha..headSha`. Omitted for the
   * whole-branch fallback (SHAs undeterminable, FR-010) and for every non
   * merge-conflict re-arm.
   */
  readonly reviewScope?: ReviewScope;
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
