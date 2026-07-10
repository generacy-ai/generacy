/**
 * Typed error class thrown by `LabelManager.retryWithBackoff` after final-attempt
 * exhaustion. Caught in `phase-loop.ts` and `claude-cli-worker.ts` via
 * `isTerminalLabelOpError(e)` and translated into a `WorkerResult.status === 'failed-terminal'`.
 *
 * See specs/889-found-during-cockpit-v1/contracts/terminal-label-op-error.md.
 */

export type TerminalLabelOpSite =
  | 'gate-hit'
  | 'phase-start'
  | 'phase-complete'
  | 'error'
  | 'resume-start'
  | 'workflow-complete';

export interface TerminalLabelOpErrorArgs {
  site: TerminalLabelOpSite;
  labelOp: string;
  ghStderr: string;
  cause?: unknown;
}

export class TerminalLabelOpError extends Error {
  readonly site: TerminalLabelOpSite;
  readonly labelOp: string;
  readonly ghStderr: string;
  readonly cause?: unknown;

  constructor(args: TerminalLabelOpErrorArgs) {
    super(
      `Label operation "${args.labelOp}" failed at site "${args.site}" after retries: ${args.ghStderr}`,
    );
    this.name = 'TerminalLabelOpError';
    this.site = args.site;
    this.labelOp = args.labelOp;
    this.ghStderr = args.ghStderr;
    if (args.cause !== undefined) {
      this.cause = args.cause;
    }
  }
}

export function isTerminalLabelOpError(e: unknown): e is TerminalLabelOpError {
  return e instanceof TerminalLabelOpError;
}
