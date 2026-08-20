import type { CiRun, CiVerdict } from '../../../types/github.js';

/**
 * Conclusions that are ignored entirely when computing merge readiness.
 * A skipped or neutral run is NOT a pass — it means CI never ran for that job
 * (skipped≠passed, #1133 / SC-001).
 */
const IGNORED_CONCLUSIONS = new Set<string>(['skipped', 'neutral']);

/**
 * Terminal conclusions that block merge readiness.
 */
const FAILING_CONCLUSIONS = new Set<string>([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
]);

/**
 * Aggregate a set of CI runs for a single head SHA into a three-state verdict.
 *
 * Pure, total, and never throws. Zero I/O.
 *
 * Precedence (per contracts/ci-verdict.md), after dropping the ignore-set
 * (`skipped`, `neutral`):
 *   1. any failing terminal conclusion → `not-passed`
 *   2. any in-progress run (`status !== 'completed'` or `conclusion === null`) → `pending`
 *   3. any `success` → `green`
 *   4. otherwise → `pending`
 *
 * Unknown terminal conclusions are treated conservatively: they are not
 * `success`, so they never contribute to a `green` verdict, and they fall
 * through to `pending` (rule 4) unless a concrete success exists.
 *
 * Invariants: empty input and all-ignored input both yield `pending` — never
 * `green` (SC-001). A `green` verdict requires at least one concrete `success`.
 */
export function aggregateCiVerdict(runs: CiRun[]): CiVerdict {
  const relevant = runs.filter(
    (run) => run.conclusion === null || !IGNORED_CONCLUSIONS.has(run.conclusion),
  );

  if (relevant.length === 0) {
    return 'pending';
  }

  // Rule 1: any failing terminal conclusion blocks readiness.
  if (
    relevant.some(
      (run) => run.conclusion !== null && FAILING_CONCLUSIONS.has(run.conclusion),
    )
  ) {
    return 'not-passed';
  }

  // Rule 2: any in-progress run keeps the verdict pending.
  if (
    relevant.some((run) => run.status !== 'completed' || run.conclusion === null)
  ) {
    return 'pending';
  }

  // Rule 3: at least one concrete success and nothing failing/in-progress.
  if (relevant.some((run) => run.conclusion === 'success')) {
    return 'green';
  }

  // Rule 4: only unknown terminal conclusions remain — conservatively pending.
  return 'pending';
}
