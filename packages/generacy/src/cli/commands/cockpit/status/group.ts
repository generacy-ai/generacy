import type { ParsedPhase } from '@generacy-ai/cockpit';
import type { StatusRow } from './row.js';

export interface RowGroup {
  header: string;
  rows: StatusRow[];
}

function formatPhaseHeader(phase: ParsedPhase): string {
  if (phase.heading.toLowerCase() === phase.token) {
    return `— ${phase.token.toUpperCase()} —`;
  }
  return `— ${phase.heading} —`;
}

const NO_PHASE_HEADER = '— (no phase) —';

export function groupRows(
  rows: StatusRow[],
  phases: ParsedPhase[],
  _epicOwnerRepo: string,
): RowGroup[] {
  const buckets = new Map<string | null, StatusRow[]>();
  for (const row of rows) {
    const bucket = buckets.get(row.phase);
    if (bucket != null) bucket.push(row);
    else buckets.set(row.phase, [row]);
  }

  const groups: RowGroup[] = [];
  for (const phase of phases) {
    const bucket = buckets.get(phase.token) ?? [];
    const order = new Map<string, number>();
    phase.refs.forEach((ref, i) => order.set(`${ref.repo}#${ref.number}`, i));
    const sorted = [...bucket].sort((a, b) => {
      const ka = `${a.repo}#${a.number}`;
      const kb = `${b.repo}#${b.number}`;
      return (order.get(ka) ?? 0) - (order.get(kb) ?? 0);
    });
    groups.push({ header: formatPhaseHeader(phase), rows: sorted });
  }

  const noneBucket = buckets.get(null) ?? [];
  if (noneBucket.length > 0 || phases.length === 0) {
    groups.push({ header: NO_PHASE_HEADER, rows: noneBucket });
  }

  return groups;
}
