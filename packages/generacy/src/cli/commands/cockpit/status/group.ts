import type { Scope } from '../shared/scoping.js';
import type { StatusRow } from './row.js';

export interface RowGroup {
  header: string;
  rows: StatusRow[];
}

/**
 * Group rows for rendering. In repos mode each repo gets its own group header.
 * In epic mode (R7) all rows are emitted flat under a single "epic owner/repo#N"
 * header.
 */
export function groupRows(rows: StatusRow[], scope: Scope): RowGroup[] {
  if (scope.kind === 'epic') {
    const sorted = [...rows].sort((a, b) => a.number - b.number);
    return [
      { header: `epic ${scope.ownerRepo}`, rows: sorted },
    ];
  }
  const byRepo = new Map<string, StatusRow[]>();
  for (const row of rows) {
    const list = byRepo.get(row.repo);
    if (list != null) {
      list.push(row);
    } else {
      byRepo.set(row.repo, [row]);
    }
  }
  const groups: RowGroup[] = [];
  for (const repo of [...byRepo.keys()].sort()) {
    const list = byRepo.get(repo)!.slice().sort((a, b) => a.number - b.number);
    groups.push({ header: repo, rows: list });
  }
  return groups;
}
