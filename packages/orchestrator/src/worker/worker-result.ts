/**
 * Discriminated result type returned by `WorkerHandler` (`ClaudeCliWorker.handle`).
 * Consumed by `WorkerDispatcher.runWorker` to decide between `queue.complete()`
 * (both variants) and `queue.release()` (never — release is the default behavior
 * on unhandled throws).
 *
 * See specs/889-found-during-cockpit-v1/contracts/worker-result.md.
 */

import type { TerminalLabelOpSite } from './terminal-label-op-error.js';

export interface FailureMetadata {
  readonly site: TerminalLabelOpSite;
  readonly labelOp: string;
  readonly ghStderr: string;
}

export type WorkerResult =
  | { readonly status: 'completed' }
  | {
      readonly status: 'failed-terminal';
      readonly failureMetadata: FailureMetadata;
    };
