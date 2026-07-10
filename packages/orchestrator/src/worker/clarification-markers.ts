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
