/**
 * Central marker set for engine-authored clarification-question comments.
 *
 * The answer-scanner in `clarification-poster.ts` uses
 * `commentCarriesQuestionMarker` to skip these comments before parsing
 * candidate `Q<n>:` answers. `isQuestionComment` delegates to the same
 * predicate for its marker branch.
 *
 * Adding a new engine dialect: append its stable HTML-comment prefix to
 * `CLARIFICATION_QUESTION_MARKERS`. No other file changes.
 *
 * Match rule:
 *  - Prefix substring, case-sensitive ASCII.
 *  - Line-anchored: only fires when the marker starts at column 0 of some line.
 *  - `> `-quoted markers therefore do NOT match — humans quoting the questions
 *    while answering still have their `Q<n>: <answer>` lines integrated.
 */
export const CLARIFICATION_QUESTION_MARKERS: readonly string[] = [
  '<!-- generacy-stage:clarification',
  '<!-- generacy-clarifications:',
  '<!-- generacy-clarification:',
  '<!-- generacy-cockpit:clarifications-batch:',
] as const;

/**
 * True iff `body` contains one of the FR-101 markers at column 0 of some line.
 */
export function commentCarriesQuestionMarker(body: string): boolean {
  return matchClarificationQuestionMarker(body) !== undefined;
}

/**
 * Same semantics as `commentCarriesQuestionMarker`; returns the specific
 * prefix string that matched (identity from `CLARIFICATION_QUESTION_MARKERS`)
 * or `undefined` if no match.
 */
export function matchClarificationQuestionMarker(body: string): string | undefined {
  for (const line of body.split('\n')) {
    for (const prefix of CLARIFICATION_QUESTION_MARKERS) {
      if (line.startsWith(prefix)) return prefix;
    }
  }
  return undefined;
}

/**
 * #958 — engine-authored *answer* marker family. A `viewerDidAuthor === true`
 * comment is treated as an answer source only when it carries one of these
 * markers at column 0 of some line. Stamped exclusively by deterministic code
 * in `packages/generacy/src/cli/commands/cockpit/clarification-answer-marker.ts`
 * — never by an LLM/agent free-writing a comment.
 *
 * Match rule (mirrors question-marker family):
 *  - Prefix substring, case-sensitive ASCII.
 *  - Line-anchored: only fires when the marker starts at column 0 of some line.
 *  - `> `-quoted markers do NOT match.
 *
 * Non-overlap with `CLARIFICATION_QUESTION_MARKERS`: the answer prefix uses
 * plural `clarification-answers:` (distinct suffix). No question-marker prefix
 * is a prefix of an answer-marker prefix, or vice versa.
 */
export const CLARIFICATION_ANSWER_MARKERS: readonly string[] = [
  '<!-- generacy-clarification-answers:',
] as const;

/**
 * True iff `body` contains one of the answer-marker prefixes at column 0.
 */
export function commentCarriesAnswerMarker(body: string): boolean {
  return matchClarificationAnswerMarker(body) !== undefined;
}

/**
 * Same semantics as `commentCarriesAnswerMarker`; returns the specific prefix
 * string that matched (identity from `CLARIFICATION_ANSWER_MARKERS`) or
 * `undefined` if no match.
 */
export function matchClarificationAnswerMarker(body: string): string | undefined {
  for (const line of body.split('\n')) {
    for (const prefix of CLARIFICATION_ANSWER_MARKERS) {
      if (line.startsWith(prefix)) return prefix;
    }
  }
  return undefined;
}

/**
 * #976 — canonical machine-marker inventory. Superset of
 * `CLARIFICATION_QUESTION_MARKERS`; also covers every stage/status, audit /
 * lifecycle, answer-relay, and bot-authored explainer comment family the
 * clarification answer scanner must never treat as an answer source.
 *
 * The monitor (`clarification-answer-monitor-service.ts`) and the phase-loop
 * scanner (`clarification-poster.ts::integrateClarificationAnswers`) both
 * pre-filter comments through this set. Same-account trust is delegated
 * entirely to `isTrustedCommentAuthor`; the identity gate at both call sites
 * is deleted in favor of this marker filter (#976 fix for agency#433).
 *
 * Why: the `<!-- generacy-clarification-answers:` entry duplicates the
 * exported `CLARIFICATION_ANSWER_MARKERS` prefix — the two must move
 * in lockstep. See `specs/976-summary-clarification-answers/data-model.md`.
 *
 * Match rule (identical to the question-marker family):
 *  - Prefix substring, case-sensitive ASCII.
 *  - Line-anchored: only fires when the marker starts at column 0 of some line.
 *  - `> `-quoted markers therefore do NOT match — humans quoting a machine
 *    comment while answering still have their `Q<n>: <answer>` lines
 *    integrated.
 */
export const MACHINE_MARKERS: readonly string[] = [
  // Question-family (superset invariant — spread from CLARIFICATION_QUESTION_MARKERS)
  ...CLARIFICATION_QUESTION_MARKERS,

  // Stage/status comments
  '<!-- generacy-stage:specification',
  '<!-- generacy-stage:planning',
  '<!-- generacy-stage:implementation',
  '<!-- speckit-stage:specification',
  '<!-- speckit-stage:planning',
  '<!-- speckit-stage:implementation',

  // Audit / lifecycle bot comments
  '<!-- generacy-cockpit:manual-advance',

  // Answer-relay marker (deprecates cockpit_relay_clarify_answers integration path)
  '<!-- generacy-clarification-answers:',

  // Bot-authored explainer / diagnostic comments
  '<!-- generacy-untrusted-answer:',
  '<!-- generacy-clarification-parse-failures:',
] as const;

/**
 * True iff `body` contains one of the `MACHINE_MARKERS` prefixes at column 0
 * of some line.
 */
export function commentCarriesMachineMarker(body: string): boolean {
  return matchMachineMarker(body) !== undefined;
}

/**
 * Same semantics as `commentCarriesMachineMarker`; returns the specific prefix
 * string that matched (identity from `MACHINE_MARKERS`) or `undefined` if no
 * match.
 */
export function matchMachineMarker(body: string): string | undefined {
  for (const line of body.split('\n')) {
    for (const prefix of MACHINE_MARKERS) {
      if (line.startsWith(prefix)) return prefix;
    }
  }
  return undefined;
}
