/**
 * #958 — `formatClarificationAnswerComment` renders the marker-stamped answer
 * comment posted by `cockpit_relay_clarify_answers`. Mirrors the deterministic
 * validation pattern in `manual-advance-marker.ts`.
 *
 * The header line matches `commentCarriesAnswerMarker` in
 * `packages/orchestrator/src/worker/clarification-markers.ts` — this is the
 * sole writer of the `<!-- generacy-clarification-answers:<batch> -->`
 * prefix. Agents never free-write it.
 *
 * Inputs are regex-validated before interpolation so a malformed `batch`,
 * `actor`, or `ts` cannot inject markdown/HTML into the marker body.
 */
import { PENDING_ANSWER_LITERAL } from '@generacy-ai/workflow-engine';

const ACTOR_REGEX = /^[A-Za-z0-9-]+$/;

export interface ClarificationAnswerMarker {
  batch: number;
  answers: Record<number, string>;
  actor?: string;
  ts: string;
}

export function formatClarificationAnswerComment(
  marker: ClarificationAnswerMarker,
): string {
  validate(marker);
  const { batch, answers, actor, ts } = marker;
  const hasActor = typeof actor === 'string' && actor.length > 0;
  const header = hasActor
    ? `<!-- generacy-clarification-answers:${batch} actor=${actor} ts=${ts} -->`
    : `<!-- generacy-clarification-answers:${batch} ts=${ts} -->`;
  const orderedKeys = Object.keys(answers)
    .map((k) => Number(k))
    .sort((a, b) => a - b);
  const answerLines = orderedKeys.map((n) => `Q${n}: ${answers[n]!}`);
  return [
    header,
    '',
    `## Answers — batch ${batch}`,
    '',
    ...answerLines,
    '',
  ].join('\n');
}

function validate(marker: ClarificationAnswerMarker): void {
  if (!Number.isInteger(marker.batch) || marker.batch < 0) {
    throw new Error(
      `formatClarificationAnswerComment: batch must be a non-negative integer (got ${String(marker.batch)})`,
    );
  }
  if (typeof marker.actor === 'string' && marker.actor.length > 0) {
    if (!ACTOR_REGEX.test(marker.actor)) {
      throw new Error(
        `formatClarificationAnswerComment: invalid actor login "${marker.actor}"`,
      );
    }
  }
  if (typeof marker.ts !== 'string' || marker.ts === '') {
    throw new Error(
      'formatClarificationAnswerComment: ts must be a non-empty ISO-8601 string',
    );
  }
  const parsed = new Date(marker.ts);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== marker.ts) {
    throw new Error(
      `formatClarificationAnswerComment: ts "${marker.ts}" is not round-trip ISO-8601`,
    );
  }
  if (marker.answers == null || typeof marker.answers !== 'object') {
    throw new Error('formatClarificationAnswerComment: answers must be a Record<number, string>');
  }
  const keys = Object.keys(marker.answers);
  if (keys.length === 0) {
    throw new Error('formatClarificationAnswerComment: answers map is empty');
  }
  for (const key of keys) {
    const n = Number(key);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(
        `formatClarificationAnswerComment: answer key "${key}" is not a positive integer`,
      );
    }
    const value = marker.answers[n];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `formatClarificationAnswerComment: answer for Q${n} is empty`,
      );
    }
  }
  // Reference the shared pending literal so the import stays live (per
  // data-model.md §"Cross-package import strategy" — divergence between the
  // parser's canonical value and cockpit's rendered surface is structurally
  // impossible). The stamped body never renders the literal itself; the tool
  // refuses empty values above.
  void PENDING_ANSWER_LITERAL;
}
