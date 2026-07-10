/**
 * Discriminated result type returned by `WorkerHandler` (`ClaudeCliWorker.handle`).
 * Consumed by `WorkerDispatcher.runWorker` to decide between `queue.complete()`
 * (both variants) and `queue.release()` (never — release is the default behavior
 * on unhandled throws).
 *
 * See specs/889-found-during-cockpit-v1/contracts/worker-result.md.
 */

import type { QueueItem } from '../types/index.js';
import type { TerminalLabelOpSite } from './terminal-label-op-error.js';

export interface FailureMetadata {
  readonly site: TerminalLabelOpSite;
  readonly labelOp: string;
  readonly ghStderr: string;
}

/**
 * Optional post-complete side-effect the dispatcher runs AFTER `queue.complete()`.
 * Used by `MergeConflictHandler`'s re-arm path (#902) to enqueue a `continue`
 * item without colliding against the still-claimed source itemKey (self-
 * deadlock guard per #902 Q1).
 */
export type PostCompleteAction =
  | { readonly kind: 'rearm'; readonly rearmItem: QueueItem };

export interface CompletedResult {
  readonly status: 'completed';
  /**
   * NEW in #902.
   * Fired by `WorkerDispatcher.runWorker` immediately after
   * `queue.complete(workerId, item)` releases the itemKey.
   */
  readonly postComplete?: PostCompleteAction;
}

export type WorkerResult =
  | CompletedResult
  | {
      readonly status: 'failed-terminal';
      readonly failureMetadata: FailureMetadata;
    };
