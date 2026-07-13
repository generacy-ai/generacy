import { firstToken } from './heading-match.js';
import { parseRef } from './ref-shapes.js';
import type { IssueRef, ParsedEpicBody, ParsedPhase } from './types.js';

const HEADING_L3_RE = /^###\s+(.+?)\s*$/;
const HEADING_L4_PLUS_RE = /^####+\s+/;
const HEADING_L2_RE = /^##\s+/;
const TASK_LIST_RE = /^\s*-\s*\[[ xX]\]\s+(.+?)\s*$/;
const REF_SHAPED_RE =
  /(?:^|[\s(])(?:#\d+|\[#?\d+\]|\[[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+\]|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#\d+|https:\/\/github\.com\/[A-Za-z0-9._\-\/]+)/;

// #826 (FR-005): rejection-family taxonomy carried in warnings[]. Each returned
// string contains exactly one documented marker substring so tests can assert
// via toContain() without pinning full wording. Do not remove or rename these
// three markers without updating parse-epic-body.test.ts and
// contracts/parser-behavior.md §Warnings:
//   - "bare '#N'"
//   - "titled but not ref-shaped"
//   - "URL path not /(issues|pull)/N"
const BARE_HASH_N_RE = /^#\d+$/;
const URL_LIKE_RE = /^https?:\/\//;
function classifyRejection(token: string): string {
  if (BARE_HASH_N_RE.test(token)) {
    return "unrecognised shape — bare '#N' shorthand is not accepted";
  }
  if (URL_LIKE_RE.test(token)) {
    return 'unrecognised shape — URL path not /(issues|pull)/N';
  }
  return 'unrecognised shape — titled but not ref-shaped';
}

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
    // #826: the ref is only the first whitespace-delimited token; everything after
    // is a free-form title consumed unparsed. All four accepted shapes in
    // ref-shapes.ts are whitespace-free tokens, so first-token extraction is
    // sufficient and passing the full refText to parseRef would fail every
    // ^…$-anchored shape.
    const refToken = refText.split(/\s+/)[0]!;

    const ref = parseRef(refToken);
    if (ref == null) {
      // First-token silence rule (FR-007): if the first token is not ref-shaped,
      // stay silent regardless of what appears later on the line — prose
      // checkboxes that mention a ref mid-sentence never warn.
      if (REF_SHAPED_RE.test(refToken)) {
        const reason = classifyRejection(refToken);
        warnings.push(
          `cockpit: ignored ref-shaped task-list line ${lineNumber}: '${refText}' (${reason})`,
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
