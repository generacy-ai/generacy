import type { FailingCheck } from './required-checks.js';

export type RedReason = 'checks-failing' | 'missing-label' | 'unresolved';

export interface IssueRefWithState {
  owner: string;
  repo: string;
  number: number;
  state?: 'OPEN' | 'CLOSED';
  stateReason?: string | null;
}

export interface FailingCheckPayload {
  status: 'red';
  reason: RedReason;
  pr: { number: number; url: string } | null;
  failingChecks: FailingCheck[];
  issue?: IssueRefWithState;
}

export interface BuildFailingCheckInput {
  reason: RedReason;
  pr: { number: number; url: string } | null;
  failingChecks?: FailingCheck[];
  issue?: IssueRefWithState;
}

export function buildFailingCheckPayload(
  input: BuildFailingCheckInput,
): FailingCheckPayload {
  const { reason, pr, failingChecks = [], issue } = input;

  if (issue !== undefined) {
    // I-6: state and stateReason are paired — if state is set, stateReason
    // must also be present (may be null). Guards against callers accidentally
    // dropping stateReason when they intend to carry state.
    const hasState = 'state' in issue;
    const hasStateReason = 'stateReason' in issue;
    if (hasState !== hasStateReason) {
      throw new Error(
        "FailingCheckPayload invariant I-6: issue.state and issue.stateReason must be set together",
      );
    }
  }

  const applyIssue = (
    payload: FailingCheckPayload,
  ): FailingCheckPayload =>
    issue === undefined ? payload : { ...payload, issue };

  if (reason === 'unresolved') {
    if (failingChecks.length !== 0) {
      throw new Error(
        "FailingCheckPayload invariant: reason='unresolved' must have empty failingChecks",
      );
    }
    return applyIssue({ status: 'red', reason, pr, failingChecks: [] });
  }

  if (reason === 'missing-label') {
    if (pr == null) {
      throw new Error(
        "FailingCheckPayload invariant: reason='missing-label' requires non-null pr",
      );
    }
    if (failingChecks.length !== 0) {
      throw new Error(
        "FailingCheckPayload invariant: reason='missing-label' must have empty failingChecks",
      );
    }
    return applyIssue({ status: 'red', reason, pr, failingChecks: [] });
  }

  if (reason === 'checks-failing') {
    if (pr == null) {
      throw new Error(
        "FailingCheckPayload invariant: reason='checks-failing' requires non-null pr",
      );
    }
    if (failingChecks.length === 0) {
      throw new Error(
        "FailingCheckPayload invariant: reason='checks-failing' requires non-empty failingChecks",
      );
    }
    return applyIssue({ status: 'red', reason, pr, failingChecks });
  }

  throw new Error(`FailingCheckPayload: unknown reason ${reason as string}`);
}

export function serializeFailingCheckJson(
  payload: FailingCheckPayload,
): string {
  return JSON.stringify(payload) + '\n';
}
