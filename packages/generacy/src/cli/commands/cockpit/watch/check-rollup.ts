import type { CheckRunSummary } from '@generacy-ai/cockpit';
import type { ChecksRollup } from './snapshot.js';

/**
 * Reduce a CheckRunSummary[] to a single 'pending' | 'success' | 'failure'
 * (plan D4). Empty array → 'pending'. Any FAILURE/CANCELLED → 'failure'.
 * All SUCCESS/NEUTRAL/SKIPPED → 'success'. Otherwise → 'pending'.
 */
export function rollup(checks: CheckRunSummary[]): ChecksRollup {
  if (checks.length === 0) return 'pending';
  let allTerminalSuccess = true;
  for (const check of checks) {
    if (check.state === 'FAILURE' || check.state === 'CANCELLED') {
      return 'failure';
    }
    if (
      check.state !== 'SUCCESS' &&
      check.state !== 'NEUTRAL' &&
      check.state !== 'SKIPPED'
    ) {
      allTerminalSuccess = false;
    }
  }
  return allTerminalSuccess ? 'success' : 'pending';
}
