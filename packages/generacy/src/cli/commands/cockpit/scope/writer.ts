import { parseRef } from '@generacy-ai/cockpit';
import type { IssueRef } from '@generacy-ai/cockpit';

export type BodyShape = 'phased' | 'flat';

export type ScopeMutation =
  | { kind: 'add'; ref: IssueRef }
  | { kind: 'remove'; ref: IssueRef };

export interface ScopeWriteResult {
  noop: boolean;
  body: string;
  shape: BodyShape;
}

// Byte-exact against parseEpicBody's HEADING_L3_RE (invariant I-1).
const HEADING_L3_RE = /^###\s+/;
const AD_HOC_HEADING_RE = /^##\s+ad-hoc\s*$/i;
const HEADING_L2_RE = /^##\s+/;
const HEADING_L1_RE = /^#\s+/;
const TASK_LIST_RE = /^\s*-\s*\[[ xX]\]\s+(.+?)\s*$/;
// #1014 (FR-011): MUST match parseEpicBody's PHASE_SHAPED_H4_RE byte-for-byte (invariant I-2).
const HEADING_L4_PLUS_RE = /^####+\s+/;
const PHASE_SHAPED_H4_RE = /^\s*(?:P\d+\b|.*\bphase\b)/i;

function refKey(ref: IssueRef): string {
  return `${ref.repo}#${ref.number}`;
}

function formatRefLine(ref: IssueRef): string {
  return `- [ ] ${ref.repo}#${ref.number}`;
}

export function detectShape(body: string): BodyShape {
  const lines = body.split(/\r?\n/);
  for (const line of lines) {
    if (HEADING_L3_RE.test(line)) return 'phased';
    if (HEADING_L4_PLUS_RE.test(line)) {
      const text = line.replace(/^####+\s+/, '').trim();
      if (PHASE_SHAPED_H4_RE.test(text)) return 'phased';
    }
  }
  return 'flat';
}

function lineMatchesRef(line: string, ref: IssueRef): boolean {
  const m = TASK_LIST_RE.exec(line);
  if (m == null) return false;
  const refText = m[1]!.trim();
  const refToken = refText.split(/\s+/)[0]!;
  const parsed = parseRef(refToken);
  if (parsed == null) return false;
  return parsed.repo === ref.repo && parsed.number === ref.number;
}

function bodyContainsRef(body: string, ref: IssueRef): boolean {
  const lines = body.split(/\r?\n/);
  return lines.some((l) => lineMatchesRef(l, ref));
}

function joinLines(lines: string[]): string {
  return lines.join('\n');
}

function ensureTrailingNewline(body: string): string {
  return body.endsWith('\n') ? body : body + '\n';
}

// Section boundary: a heading at level <= 2 (## or #), or another ## Ad-hoc,
// terminates the Ad-hoc section. #### and #####+ do not terminate (they're
// subsections of the Ad-hoc section).
function isAdhocSectionBoundary(line: string): boolean {
  return HEADING_L1_RE.test(line) || HEADING_L2_RE.test(line);
}

function findAdhocRange(
  lines: string[],
): { headingIdx: number; endIdx: number } | null {
  for (let i = 0; i < lines.length; i++) {
    if (AD_HOC_HEADING_RE.test(lines[i]!)) {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j++) {
        if (isAdhocSectionBoundary(lines[j]!)) {
          end = j;
          break;
        }
      }
      return { headingIdx: i, endIdx: end };
    }
  }
  return null;
}

function findLastTaskListInRange(
  lines: string[],
  startIdx: number,
  endIdx: number,
): number {
  for (let i = endIdx - 1; i > startIdx; i--) {
    if (TASK_LIST_RE.test(lines[i]!)) return i;
  }
  return -1;
}

function addToPhased(body: string, ref: IssueRef): string {
  // Strip trailing newline so split('\n') doesn't produce a phantom empty
  // element that scrambles insertion positions. Reattach on the way out.
  const hadTrailingNewline = body.endsWith('\n');
  const workBody = hadTrailingNewline ? body.slice(0, -1) : body;
  const lines = workBody.length === 0 ? [] : workBody.split('\n');
  const range = findAdhocRange(lines);
  const newLine = formatRefLine(ref);

  let outLines: string[];
  if (range != null) {
    const lastTask = findLastTaskListInRange(lines, range.headingIdx, range.endIdx);
    if (lastTask >= 0) {
      outLines = [...lines.slice(0, lastTask + 1), newLine, ...lines.slice(lastTask + 1)];
    } else {
      const insertAt = range.headingIdx + 1;
      const next = lines[insertAt];
      if (next == null) {
        outLines = [...lines, '', newLine];
      } else if (next.trim() === '') {
        outLines = [...lines.slice(0, insertAt + 1), newLine, ...lines.slice(insertAt + 1)];
      } else {
        outLines = [...lines.slice(0, insertAt), '', newLine, '', ...lines.slice(insertAt)];
      }
    }
  } else {
    outLines = [...lines, '', '## Ad-hoc', '', newLine];
  }

  const joined = joinLines(outLines);
  return hadTrailingNewline ? joined + '\n' : joined;
}

function addToFlat(body: string, ref: IssueRef): string {
  const newLine = formatRefLine(ref);
  if (body.length === 0) return `${newLine}\n`;
  const withNewline = ensureTrailingNewline(body);
  return `${withNewline}${newLine}\n`;
}

function removeMatchingLine(body: string, ref: IssueRef): string {
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => lineMatchesRef(l, ref));
  if (idx < 0) return body;
  return joinLines([...lines.slice(0, idx), ...lines.slice(idx + 1)]);
}

/**
 * Pure body writer. Applies the mutation according to shape rules described
 * in contracts/scope-writer.md. Idempotent in both directions.
 */
export function applyScopeMutation(
  body: string,
  mutation: ScopeMutation,
): ScopeWriteResult {
  const shape = detectShape(body);

  if (mutation.kind === 'add') {
    if (bodyContainsRef(body, mutation.ref)) {
      return { noop: true, body, shape };
    }
    const next =
      shape === 'phased'
        ? addToPhased(body, mutation.ref)
        : addToFlat(body, mutation.ref);
    return { noop: false, body: next, shape };
  }

  // remove
  if (!bodyContainsRef(body, mutation.ref)) {
    return { noop: true, body, shape };
  }
  const next = removeMatchingLine(body, mutation.ref);
  return { noop: false, body: next, shape };
}
