import type {
  CheckRunSummary,
  RequiredChecksResult,
} from '@generacy-ai/cockpit';

export type FailingCheckState =
  | 'FAILURE'
  | 'PENDING'
  | 'NEUTRAL'
  | 'SKIPPED'
  | 'CANCELLED'
  | 'MISSING';

export interface FailingCheck {
  name: string;
  state: FailingCheckState;
  url?: string;
}

export interface ClassifyChecksInput {
  required: RequiredChecksResult;
  actual: CheckRunSummary[];
}

export interface ClassifyChecksResult {
  failingChecks: FailingCheck[];
  ok: boolean;
}

export function classifyChecks(
  input: ClassifyChecksInput,
): ClassifyChecksResult {
  const { required, actual } = input;
  const failing: FailingCheck[] = [];

  if (required.source === 'branch-protection') {
    const actualByName = new Map<string, CheckRunSummary>();
    for (const check of actual) {
      actualByName.set(check.name, check);
    }
    const requiredNames = required.names ?? [];
    for (const name of requiredNames) {
      const found = actualByName.get(name);
      if (!found) {
        failing.push({ name, state: 'MISSING' });
        continue;
      }
      if (found.state !== 'SUCCESS') {
        failing.push({
          name: found.name,
          state: found.state as FailingCheckState,
          ...(found.url != null ? { url: found.url } : {}),
        });
      }
    }
  } else {
    for (const check of actual) {
      if (check.state !== 'SUCCESS') {
        failing.push({
          name: check.name,
          state: check.state as FailingCheckState,
          ...(check.url != null ? { url: check.url } : {}),
        });
      }
    }
  }

  return { failingChecks: failing, ok: failing.length === 0 };
}
