import { firstToken } from './heading-match.js';
import { parseRef } from './ref-shapes.js';
import type { IssueRef, ParsedEpicBody, ParsedPhase } from './types.js';

const HEADING_L3_RE = /^###\s+(.+?)\s*$/;
const HEADING_L4_PLUS_RE = /^####+\s+/;
const HEADING_L2_RE = /^##\s+/;
const TASK_LIST_RE = /^\s*-\s*\[[ xX]\]\s+(.+?)\s*$/;
const REF_SHAPED_RE =
  /(?:^|[\s(])(?:#\d+|\[#?\d+\]|\[[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+\]|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+|https:\/\/github\.com\/[A-Za-z0-9._\-\/]+)/;

function sortRefs(refs: Iterable<IssueRef>): IssueRef[] {
  return [...refs].sort((a, b) => {
    if (a.repo < b.repo) return -1;
    if (a.repo > b.repo) return 1;
    return a.number - b.number;
  });
}

function dedupKey(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

/**
 * Line-oriented walk over an epic issue body.
 *
 * Grammar (see contracts/resolver.md):
 *   - Heading (level 3): `^### (.+)$` — opens a phase.
 *   - Heading (level 4+): `^#### … $` — closes the current phase.
 *   - Heading (level 2): `^## …$` — ignored.
 *   - Task-list item: `^\s*- \[[ xX]\] (ref-shape)` — appends a ref to the current phase.
 *
 * Rejected but ref-shaped lines (e.g. bare `#N`) produce a `warnings[]` entry.
 * Pure function — no throws, no I/O.
 */
export function parseEpicBody(body: string): ParsedEpicBody {
  const phases: ParsedPhase[] = [];
  const warnings: string[] = [];
  const globalRefs = new Map<string, IssueRef>();

  let current: ParsedPhase | null = null;
  let currentSeen = new Set<string>();

  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNumber = i + 1;

    if (HEADING_L4_PLUS_RE.test(line)) {
      current = null;
      currentSeen = new Set();
      continue;
    }

    if (HEADING_L2_RE.test(line)) {
      continue;
    }

    const h3 = HEADING_L3_RE.exec(line);
    if (h3 != null) {
      const heading = h3[1]!.trim();
      const token = firstToken(heading);
      current = { heading, token, refs: [] };
      currentSeen = new Set();
      phases.push(current);
      continue;
    }

    const task = TASK_LIST_RE.exec(line);
    if (task == null) continue;
    const refText = task[1]!.trim();

    const ref = parseRef(refText);
    if (ref == null) {
      if (REF_SHAPED_RE.test(refText)) {
        warnings.push(
          `cockpit: ignored ref-shaped task-list line ${lineNumber}: '${refText}' (unrecognised shape — bare '#N' shorthand is not accepted)`,
        );
      }
      continue;
    }

    if (current == null) continue;

    const key = dedupKey(ref);
    if (!currentSeen.has(key)) {
      currentSeen.add(key);
      current.refs.push(ref);
    }
    if (!globalRefs.has(key)) {
      globalRefs.set(key, ref);
    }
  }

  const allRefs = sortRefs(globalRefs.values());

  return { phases, allRefs, warnings };
}
