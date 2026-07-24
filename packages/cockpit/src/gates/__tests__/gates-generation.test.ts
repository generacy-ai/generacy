import { describe, expect, it } from 'vitest';
import {
  deriveClarificationGeneration,
  deriveImplementationReviewGeneration,
  deriveGateKey,
  deriveGateId,
} from '../index.js';

describe('deriveClarificationGeneration — canonicalization (SC-002 parity, INV-1)', () => {
  it('produces the reference sha256[:24] for the data-model.md §4 sample', () => {
    // Reference constant committed inline — any drift in the canonical bytes
    // (sort key, fixed-key map, JSON encoding, hash algorithm, or truncation
    // window) breaks this test. If it breaks, the sweep-vs-live equality
    // invariant (SC-002) is broken — do NOT relax the assertion; fix the drift.
    const gen = deriveClarificationGeneration({
      questions: [
        { questionNumber: 2, questionText: 'What is the retry budget?' },
        { questionNumber: 1, questionText: 'Which transport should we use?' },
      ],
    });
    expect(gen).toBe('8c31500d99ecf5e178f059fe');
  });

  it('is order-independent — same set of questions in different insertion order hashes identically', () => {
    const ascending = deriveClarificationGeneration({
      questions: [
        { questionNumber: 1, questionText: 'Which transport should we use?' },
        { questionNumber: 2, questionText: 'What is the retry budget?' },
      ],
    });
    const descending = deriveClarificationGeneration({
      questions: [
        { questionNumber: 2, questionText: 'What is the retry budget?' },
        { questionNumber: 1, questionText: 'Which transport should we use?' },
      ],
    });
    expect(ascending).toBe(descending);
  });

  it('deriveGateId(deriveGateKey(..., clarification, gen)) is byte-identical for sweep and live paths', () => {
    // The load-bearing sweep-vs-live equality (SC-002). Given identical inputs,
    // the sweep path (agency) and the live path (this repo) MUST produce the
    // same gateId.
    const issueRef = 'generacy-ai/generacy#1038';
    const questions = [
      { questionNumber: 1, questionText: 'Which transport should we use?' },
      { questionNumber: 2, questionText: 'What is the retry budget?' },
    ];
    const genSweep = deriveClarificationGeneration({ questions });
    const genLive = deriveClarificationGeneration({ questions: [...questions].reverse() });
    const idSweep = deriveGateId(deriveGateKey(issueRef, 'clarification', genSweep));
    const idLive = deriveGateId(deriveGateKey(issueRef, 'clarification', genLive));
    expect(idSweep).toBe(idLive);
    expect(idSweep).toHaveLength(24);
  });

  it('deriveGateId(deriveGateKey(..., implementation-review, headSha)) parity — same input, same id', () => {
    // Same-input equality for the second sweep-critical gate type.
    const issueRef = 'generacy-ai/generacy#1038';
    const headSha = 'abc123def456abc123def456abc123def456abcd';
    const genSweep = deriveImplementationReviewGeneration({ headSha });
    const genLive = deriveImplementationReviewGeneration({ headSha });
    const idSweep = deriveGateId(deriveGateKey(issueRef, 'implementation-review', genSweep));
    const idLive = deriveGateId(deriveGateKey(issueRef, 'implementation-review', genLive));
    expect(idSweep).toBe(idLive);
    expect(idSweep).toHaveLength(24);
  });

  it('preserves whitespace verbatim — trimming would drift between sweep and live paths', () => {
    // data-model.md §4: "questionText: verbatim string; leading/trailing
    // whitespace is preserved because the sweep parses off GitHub verbatim and
    // the live path passes what the LLM produced verbatim — trimming would
    // drift."
    const untrimmed = deriveClarificationGeneration({
      questions: [{ questionNumber: 1, questionText: '  trimmed  ' }],
    });
    const trimmed = deriveClarificationGeneration({
      questions: [{ questionNumber: 1, questionText: 'trimmed' }],
    });
    expect(untrimmed).not.toBe(trimmed);
  });

  it('empty questions array is legal and deterministic', () => {
    const a = deriveClarificationGeneration({ questions: [] });
    const b = deriveClarificationGeneration({ questions: [] });
    expect(a).toBe(b);
    expect(a).toHaveLength(24);
  });
});
