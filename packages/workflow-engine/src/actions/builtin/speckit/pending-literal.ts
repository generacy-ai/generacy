/**
 * Single-source constant for the "not yet answered" placeholder in
 * `clarifications.md`'s `**Answer**:` field.
 *
 * The prompt template (`clarify.ts`), the orchestrator's parser and
 * write-back regex, and the cockpit answer-relay tool all import from
 * here — divergence between what the prompt writes and what the parser
 * looks for is structurally impossible.
 *
 * Home: workflow-engine (per data-model.md D1 — orchestrator already
 * depends on workflow-engine; the reverse would form a cycle).
 */
export const PENDING_ANSWER_LITERAL = '*Pending*';

/**
 * True iff `v` should be treated as an unanswered clarification value.
 *
 * Accepts (returns true):
 *  - empty string
 *  - whitespace-only
 *  - the exact literal `*Pending*`
 *  - any single `[…]`-bracketed placeholder — `[Leave empty for now]`,
 *    `[TBD]`, `[TODO]`, `[]`. Shape-based (not case-based).
 *
 * Rejects (returns false):
 *  - real answers: `A`, prose, etc.
 *  - bracketed prefix + text: `[foo] bar`
 *  - multiple brackets: `[a][b]`
 *
 * Failure direction is deliberately "ask again": unknown placeholder
 * shapes read as pending rather than answered.
 */
export function isPendingAnswerValue(v: string): boolean {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (t === '') return true;
  if (t === PENDING_ANSWER_LITERAL) return true;
  return /^\[[^\]]*\]$/.test(t);
}
