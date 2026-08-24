import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { WorkerContext } from './types.js';

/**
 * Result of evaluating a workflow's `tasks.md` as the fallback source of truth
 * for whether the implement phase actually finished (#1187).
 *
 * - `incomplete` — one or more unchecked task lines remain; the engine
 *   synthesizes a partial `implementResult` to re-enter implement.
 * - `complete` — zero unchecked task lines (all checked OR no task lines at
 *   all); the phase advances exactly as today.
 * - `unreadable` — the fallback source could not be resolved/read (missing or
 *   ambiguous spec dir, missing/unreadable `tasks.md`); the phase advances
 *   (fail-open) and the reason is logged.
 */
export type TasksMdEvaluation =
  | { kind: 'incomplete'; unchecked: number; checked: number; total: number }
  | { kind: 'complete'; unchecked: 0; checked: number; total: number }
  | { kind: 'unreadable'; reason: string };

/** Matches a GitHub-style checklist line: `- [ ]`, `- [x]`, `- [X]`, `*`/`+` bullets, leading whitespace. */
const CHECKBOX_LINE = /^[ \t]*[-*+] \[( |x|X)\]/;

/**
 * Pure checkbox counter over `tasks.md` content. Splits on newlines and tests
 * each line against {@link CHECKBOX_LINE}; a single-space capture is unchecked,
 * `x`/`X` is checked. Non-matching lines are ignored. Idempotent, no I/O.
 */
export function countTasks(content: string): {
  unchecked: number;
  checked: number;
  total: number;
} {
  let unchecked = 0;
  let checked = 0;

  for (const line of content.split('\n')) {
    const match = CHECKBOX_LINE.exec(line);
    if (match === null) {
      continue;
    }
    if (match[1] === ' ') {
      unchecked += 1;
    } else {
      checked += 1;
    }
  }

  return { unchecked, checked, total: unchecked + checked };
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

  const { unchecked, checked, total } = countTasks(content);
  if (unchecked > 0) {
    return { kind: 'incomplete', unchecked, checked, total };
  }
  return { kind: 'complete', unchecked: 0, checked, total };
}
