import type { LinkMethod, PrCandidate } from '@generacy-ai/cockpit';
import type { FailingCheck } from './required-checks.js';

export type { LinkMethod, PrCandidate } from '@generacy-ai/cockpit';

export type RedReason =
  | 'checks-failing'
  | 'missing-label'
  | 'unresolved'
  | 'pr-is-draft'
  | 'ambiguous-resolution'
  | 'pr-flag-linkage-refused'
  | 'pr-flag-closed-unmerged';

/** FR-006a — sub-kind for `pr-flag-linkage-refused` refusals. */
export type PrFlagLinkageKind = 'empty-refs' | 'mismatch';

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
  pr: { number: number; url: string; linkMethod?: LinkMethod } | null;
  candidates?: PrCandidate[];
  linkMethod?: LinkMethod;
  failingChecks: FailingCheck[];
  issue?: IssueRefWithState;
  /** FR-006a — sub-kind for `pr-flag-linkage-refused` refusals. */
  kind?: PrFlagLinkageKind;
  /** Human-readable remediation string for pr-flag refusals. */
  message?: string;
}

export interface BuildFailingCheckInput {
  reason: RedReason;
  pr: { number: number; url: string; linkMethod?: LinkMethod } | null;
  candidates?: PrCandidate[];
  linkMethod?: LinkMethod;
  failingChecks?: FailingCheck[];
  issue?: IssueRefWithState;
  /** Only for `pr-flag-linkage-refused`. */
  kind?: PrFlagLinkageKind;
  /** Only for `pr-flag-linkage-refused` and `pr-flag-closed-unmerged`. */
  message?: string;
}

export function buildFailingCheckPayload(
  input: BuildFailingCheckInput,
): FailingCheckPayload {
  const { reason, pr, candidates, linkMethod, failingChecks = [], issue, kind, message } = input;

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

  // I-10/I-11: `candidates` and top-level `linkMethod` MUST NOT be set for
  // single-PR reasons.
  const isSinglePrReason =
    reason === 'unresolved' ||
    reason === 'missing-label' ||
    reason === 'checks-failing' ||
    reason === 'pr-flag-linkage-refused' ||
    reason === 'pr-flag-closed-unmerged';
  if (isSinglePrReason && candidates !== undefined) {
    throw new Error(
      `FailingCheckPayload invariant I-10: candidates MUST NOT be set for reason='${reason}'`,
    );
  }
  if (isSinglePrReason && linkMethod !== undefined) {
    throw new Error(
      `FailingCheckPayload invariant I-11: top-level linkMethod MUST NOT be set for reason='${reason}'`,
    );
  }

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
    if (pr.linkMethod === undefined) {
      throw new Error(
        "FailingCheckPayload invariant I-9: reason='missing-label' requires pr.linkMethod to be set",
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
    if (pr.linkMethod === undefined) {
      throw new Error(
        "FailingCheckPayload invariant I-9: reason='checks-failing' requires pr.linkMethod to be set",
      );
    }
    if (failingChecks.length === 0) {
      throw new Error(
        "FailingCheckPayload invariant: reason='checks-failing' requires non-empty failingChecks",
      );
    }
    return applyIssue({ status: 'red', reason, pr, failingChecks });
  }

  if (reason === 'pr-is-draft') {
    if (pr !== null) {
      throw new Error(
        "FailingCheckPayload invariant I-7: reason='pr-is-draft' requires pr === null",
      );
    }
    if (!candidates || candidates.length < 1) {
      throw new Error(
        "FailingCheckPayload invariant I-7: reason='pr-is-draft' requires candidates.length >= 1",
      );
    }
    if (candidates.some((c) => c.isDraft !== true)) {
      throw new Error(
        "FailingCheckPayload invariant I-7: reason='pr-is-draft' requires every candidate.isDraft === true",
      );
    }
    if (linkMethod === undefined) {
      throw new Error(
        "FailingCheckPayload invariant I-7: reason='pr-is-draft' requires top-level linkMethod",
      );
    }
    if (failingChecks.length !== 0) {
      throw new Error(
        "FailingCheckPayload invariant I-7: reason='pr-is-draft' must have empty failingChecks",
      );
    }
    return applyIssue({
      status: 'red',
      reason,
      pr: null,
      candidates,
      linkMethod,
      failingChecks: [],
    });
  }

  if (reason === 'ambiguous-resolution') {
    if (pr !== null) {
      throw new Error(
        "FailingCheckPayload invariant I-8: reason='ambiguous-resolution' requires pr === null",
      );
    }
    if (!candidates || candidates.length < 2) {
      throw new Error(
        "FailingCheckPayload invariant I-8: reason='ambiguous-resolution' requires candidates.length >= 2",
      );
    }
    if (candidates.some((c) => c.isDraft !== false)) {
      throw new Error(
        "FailingCheckPayload invariant I-8: reason='ambiguous-resolution' requires every candidate.isDraft === false",
      );
    }
    if (linkMethod === undefined) {
      throw new Error(
        "FailingCheckPayload invariant I-8: reason='ambiguous-resolution' requires top-level linkMethod",
      );
    }
    if (failingChecks.length !== 0) {
      throw new Error(
        "FailingCheckPayload invariant I-8: reason='ambiguous-resolution' must have empty failingChecks",
      );
    }
    return applyIssue({
      status: 'red',
      reason,
      pr: null,
      candidates,
      linkMethod,
      failingChecks: [],
    });
  }

  if (reason === 'pr-flag-linkage-refused') {
    if (pr == null) {
      throw new Error(
        "FailingCheckPayload invariant: reason='pr-flag-linkage-refused' requires non-null pr",
      );
    }
    if (kind !== 'empty-refs' && kind !== 'mismatch') {
      throw new Error(
        "FailingCheckPayload invariant: reason='pr-flag-linkage-refused' requires kind ∈ { 'empty-refs' | 'mismatch' }",
      );
    }
    if (failingChecks.length !== 0) {
      throw new Error(
        "FailingCheckPayload invariant: reason='pr-flag-linkage-refused' must have empty failingChecks",
      );
    }
    const base: FailingCheckPayload = {
      status: 'red',
      reason,
      pr,
      failingChecks: [],
      kind,
    };
    if (message !== undefined) base.message = message;
    return applyIssue(base);
  }

  if (reason === 'pr-flag-closed-unmerged') {
    if (pr == null) {
      throw new Error(
        "FailingCheckPayload invariant: reason='pr-flag-closed-unmerged' requires non-null pr",
      );
    }
    if (failingChecks.length !== 0) {
      throw new Error(
        "FailingCheckPayload invariant: reason='pr-flag-closed-unmerged' must have empty failingChecks",
      );
    }
    const base: FailingCheckPayload = {
      status: 'red',
      reason,
      pr,
      failingChecks: [],
    };
    if (message !== undefined) base.message = message;
    return applyIssue(base);
  }

  throw new Error(`FailingCheckPayload: unknown reason ${reason as string}`);
}

export function serializeFailingCheckJson(
  payload: FailingCheckPayload,
): string {
  return JSON.stringify(payload) + '\n';
}
