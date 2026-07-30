import { createHash } from 'node:crypto';

/**
 * A single question in a clarification-gate answer set.
 *
 * The canonical hash projects to only `questionNumber` + `questionText` —
 * extra fields (e.g. drafted answers, timestamps) are stripped and MUST NOT
 * influence gate identity. Same round of asks → same generation.
 */
export interface ClarificationQuestion {
  questionNumber: number;
  questionText: string;
}

export interface ComputeClarificationAnswerSetHashInput {
  questions: readonly ClarificationQuestion[];
}

/**
 * Canonical answer-set hash for a `clarification`-gate `generation` (#1038).
 *
 * Algorithm (locked by SC-002 — MUST match agency sweep byte-for-byte):
 *   1. Sort ascending by `questionNumber`.
 *   2. Project to exactly `{ questionNumber, questionText }` (drop any extra
 *      fields — this is the mechanical enforcement of "question identity
 *      only; drafted/pending answers excluded" per spec Q1 → A).
 *   3. `JSON.stringify` the projected array.
 *   4. `sha256` the canonical string.
 *   5. Return the first 12 hex characters (48 bits — collision-safe for the
 *      population; keeps `gateKey` short in logs).
 *
 * Consumers pass the returned string as the `batchId` argument to
 * `deriveClarificationGeneration({ batchId })`. Both the agency-side sweep
 * and the cluster-side live path MUST go through this helper.
 */
export function computeClarificationAnswerSetHash(
  input: ComputeClarificationAnswerSetHashInput,
): string {
  const sorted = [...input.questions].sort((a, b) => a.questionNumber - b.questionNumber);
  const canonical = JSON.stringify(
    sorted.map((q) => ({
      questionNumber: q.questionNumber,
      questionText: q.questionText,
    })),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12);
}
