import type { StatusRow } from './row.js';

export interface RowGroup {
  header: string;
  rows: StatusRow[];
}

/**
 * Group rows for rendering. `status --epic` renders every row under a single
 * `epic owner/repo#N` header, sorted by number.
 */
export function groupRows(rows: StatusRow[], epicOwnerRepo: string): RowGroup[] {
  const sorted = [...rows].sort((a, b) => a.number - b.number);
  return [{ header: `epic ${epicOwnerRepo}`, rows: sorted }];
}
