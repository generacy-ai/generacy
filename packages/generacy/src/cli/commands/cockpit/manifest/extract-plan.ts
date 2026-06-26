import { CockpitExit } from '../exit.js';

/**
 * Extract the bare repo-relative path from a `Plan:` line in an epic body.
 *
 * Accepts:
 *   - `Plan: docs/x.md`
 *   - `Plan: docs/x.md in tetrad-development`
 *   - `Plan: docs/x.md in tetrad-development (P3 / G3.1)`
 *
 * Strips trailing `\s+in\s+\S+` (qualifier) before trailing `\s*\(.+\)\s*$`
 * (parenthesized suffix). Order matters: the qualifier is stripped first so
 * that the parenthesized suffix matcher only sees the rest.
 *
 * Throws `CockpitExit(2, ...)` if no `Plan:` line is found.
 * Multiple `Plan:` lines → first one wins.
 */
export function extractPlan(body: string): string {
  for (const rawLine of body.split(/\r?\n/)) {
    const m = rawLine.match(/^Plan:\s*(.+)$/);
    if (m == null) continue;
    let value = m[1]!;
    value = value.replace(/\s*\(.+\)\s*$/, '');
    value = value.replace(/\s+in\s+\S+\s*$/, '');
    value = value.trim();
    if (value.length === 0) continue;
    return value;
  }
  throw new CockpitExit(
    2,
    `Error: cockpit manifest init: epic body has no "Plan:" line. Add a line like 'Plan: docs/<your-plan>.md' to the epic body.`,
  );
}
