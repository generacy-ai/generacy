import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { WorkerContext } from './types.js';

/**
 * Result of evaluating a workflow's `tasks.md` as the fallback source of truth
 * for whether the implement phase actually finished (#1187).
 *
 * - `incomplete` — unchecked task lines remain and at least one of them is
 *   automatable; the engine synthesizes a partial `implementResult` (from the
 *   `automatable` count only) to re-enter implement.
 * - `manual-only` — unchecked task lines remain but every one of them
 *   classifies manual (#1214); re-entry cannot make progress, so the engine
 *   pauses on `waiting-for:manual-validation` instead.
 * - `complete` — zero unchecked task lines (all checked OR no task lines at
 *   all); the phase advances exactly as today.
 * - `unreadable` — the fallback source could not be resolved/read (missing or
 *   ambiguous spec dir, missing/unreadable `tasks.md`); the phase advances
 *   (fail-open) and the reason is logged.
 */
export type TasksMdEvaluation =
  | {
      kind: 'incomplete';
      unchecked: number;
      automatable: number;
      manual: number;
      checked: number;
      total: number;
    }
  | { kind: 'manual-only'; unchecked: number; manual: number; checked: number; total: number }
  | { kind: 'complete'; unchecked: 0; checked: number; total: number }
  | { kind: 'unreadable'; reason: string };

/** Matches a GitHub-style checklist line: `- [ ]`, `- [x]`, `- [X]`, `*`/`+` bullets, leading whitespace. */
const CHECKBOX_LINE = /^[ \t]*[-*+] \[( |x|X)\]/;

/**
 * Matches a heading task line: `#{1,6}` + whitespace + a task ID (`T\d+`)
 * immediately after the heading marker. The `(?![-–—]\s*T?\d)` boundary rejects
 * range/summary follow-ons (`### T001-T026 remaining`, en-/em-dash variants) so
 * they count as zero tasks (FR-001, Q3=A).
 */
const HEADING_TASK = /^#{1,6}[ \t]+T\d+(?![-–—]\s*T?\d)\b/;

/**
 * A heading task is checked only when `[DONE]` appears immediately after the
 * task-ID token (`### T001 [DONE] ...`). Strict, case-sensitive (FR-002, Q2=B) —
 * a `[DONE]` mid-title or at line-end leaves the task unchecked.
 */
const HEADING_DONE = /^#{1,6}[ \t]+T\d+[ \t]+\[DONE\]/;

/**
 * Tier 1 manual detector (#1214, Q3=A): the literal bracketed `[manual]` token,
 * case-insensitive, anywhere in the task text. Deliberately position-lenient —
 * the field evidence (Painworth/ai-lawfirm#2714) puts the marker at line end —
 * which is the opposite discipline from {@link HEADING_DONE}. The marker only
 * classifies an already-unchecked task; it never affects checked/unchecked
 * counting, so `### T001 [DONE] Verify flow [manual]` is checked, full stop.
 */
const MANUAL_MARKER = /\[manual\]/i;

/**
 * Tier 2 manual detector (#1214, Q2=B): whole-word `manual` / `manually` /
 * `hand-test`, case-insensitive. Runs only when Tier 1 does not match, and only
 * against the first {@link MANUAL_KEYWORD_WINDOW_WORDS} words of the task text
 * — the strict-positional discipline of {@link HEADING_DONE} — so mid-sentence
 * noun uses ("rewrite the entire user manual section") do not classify manual.
 * Whole-word means `manuals` does not match.
 */
const MANUAL_KEYWORDS = /\b(?:manual|manually|hand-test)\b/i;

/** Keyword window: manual intent is stated up front ("Manually verify …"). */
const MANUAL_KEYWORD_WINDOW_WORDS = 4;

/**
 * Prefixes stripped to obtain the **task text** — the prose a task author
 * writes, with the grammar's bookkeeping (checkbox, task ID, `[DONE]`) removed
 * so the Tier 2 window starts at the same place in both grammars.
 */
const CHECKBOX_TASK_PREFIX = /^[ \t]*[-*+] \[( |x|X)\][ \t]*(?:T\d+[ \t]+)?/;
const HEADING_TASK_PREFIX = /^#{1,6}[ \t]+T\d+[ \t]*(?:\[DONE\][ \t]*)?/;

/**
 * Pure per-line manual classifier (#1214). Applied only to lines the counter has
 * already recognized as **unchecked** tasks — a checked manual task is simply
 * checked (FR-005/006).
 */
function classifiesManual(line: string, taskPrefix: RegExp): boolean {
  const taskText = line.replace(taskPrefix, '');
  if (MANUAL_MARKER.test(taskText)) return true;
  const window = taskText
    .trim()
    .split(/\s+/)
    .slice(0, MANUAL_KEYWORD_WINDOW_WORDS)
    .join(' ');
  return MANUAL_KEYWORDS.test(window);
}

/**
 * Pure task counter over `tasks.md` content, recognizing both task grammars the
 * implement prompt emits:
 *
 * - **Checkbox** (`- [ ] T001` / `- [x] T001`): single-space capture is
 *   unchecked, `x`/`X` is checked.
 * - **Heading** (`### T001` / `### T001 [DONE]`): a {@link HEADING_TASK} match is
 *   checked iff {@link HEADING_DONE} also matches (strict `[DONE]` position).
 *
 * Each line is tested against the checkbox grammar first and skipped on match
 * (byte-identical checkbox behavior, FR-004); otherwise it is tested against the
 * heading grammar. Both grammars increment the same counters, so mixed-grammar
 * files sum (FR-003). Non-matching lines are ignored. Idempotent, no I/O.
 *
 * `manual` (#1214) counts the subset of **unchecked** tasks that
 * {@link classifiesManual} recognizes. It is additive: `unchecked`, `checked`
 * and `total` are byte-identical to #1187.
 */
export function countTasks(content: string): {
  unchecked: number;
  checked: number;
  total: number;
  manual: number;
} {
  let unchecked = 0;
  let checked = 0;
  let manual = 0;

  for (const line of content.split('\n')) {
    const match = CHECKBOX_LINE.exec(line);
    if (match !== null) {
      if (match[1] === ' ') {
        unchecked += 1;
        if (classifiesManual(line, CHECKBOX_TASK_PREFIX)) manual += 1;
      } else {
        checked += 1;
      }
      continue;
    }

    if (HEADING_TASK.test(line)) {
      if (HEADING_DONE.test(line)) {
        checked += 1;
      } else {
        unchecked += 1;
        if (classifiesManual(line, HEADING_TASK_PREFIX)) manual += 1;
      }
    }
  }

  return { unchecked, checked, total: unchecked + checked, manual };
}

/**
 * FS-backed evaluator: resolves `specs/{issueNumber}-*` under the checkout and
 * reads `tasks.md`, classifying per the #1187 contract. Never throws — every
 * I/O or resolution failure maps to an `unreadable` result so the phase loop
 * fails open (advances) rather than stalling.
 */
export function evaluateTasksMd(context: WorkerContext): TasksMdEvaluation {
  const { checkoutPath } = context;
  const { issueNumber } = context.item;
  const specsDir = join(checkoutPath, 'specs');

  let entries: string[];
  try {
    entries = readdirSync(specsDir);
  } catch (error) {
    return { kind: 'unreadable', reason: `specs dir not readable: ${String(error)}` };
  }

  const prefix = `${issueNumber}-`;
  const matches = entries.filter((entry) => entry.startsWith(prefix));
  const specDir = matches[0];
  if (specDir === undefined) {
    return { kind: 'unreadable', reason: `no spec dir for issue ${issueNumber}` };
  }
  if (matches.length > 1) {
    return {
      kind: 'unreadable',
      reason: `ambiguous spec dirs for issue ${issueNumber}: ${matches.join(', ')}`,
    };
  }

  const tasksPath = join(specsDir, specDir, 'tasks.md');
  let content: string;
  try {
    content = readFileSync(tasksPath, 'utf8');
  } catch (error) {
    return { kind: 'unreadable', reason: `tasks.md not readable: ${String(error)}` };
  }

  const { unchecked, checked, total, manual } = countTasks(content);
  const automatable = unchecked - manual;
  if (unchecked > 0 && automatable === 0) {
    return { kind: 'manual-only', unchecked, manual, checked, total };
  }
  if (unchecked > 0) {
    return { kind: 'incomplete', unchecked, automatable, manual, checked, total };
  }
  return { kind: 'complete', unchecked: 0, checked, total };
}
