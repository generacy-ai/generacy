import type { FailingCheck } from './required-checks.js';

export type RedReason = 'checks-failing' | 'missing-label' | 'unresolved';

export interface FailingCheckPayload {
  status: 'red';
  reason: RedReason;
  pr: { number: number; url: string } | null;
  failingChecks: FailingCheck[];
}

export interface BuildFailingCheckInput {
  reason: RedReason;
  pr: { number: number; url: string } | null;
  failingChecks?: FailingCheck[];
}

export function buildFailingCheckPayload(
  input: BuildFailingCheckInput,
): FailingCheckPayload {
  const { reason, pr, failingChecks = [] } = input;

  if (reason === 'unresolved') {
    if (failingChecks.length !== 0) {
      throw new Error(
        "FailingCheckPayload invariant: reason='unresolved' must have empty failingChecks",
      );
    }
    return { status: 'red', reason, pr, failingChecks: [] };
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
    return { status: 'red', reason, pr, failingChecks: [] };
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
    return { status: 'red', reason, pr, failingChecks };
  }

  throw new Error(`FailingCheckPayload: unknown reason ${reason as string}`);
}

export function serializeFailingCheckJson(
  payload: FailingCheckPayload,
): string {
  return JSON.stringify(payload) + '\n';
}
