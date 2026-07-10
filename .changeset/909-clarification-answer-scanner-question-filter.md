---
"@generacy-ai/orchestrator": patch
---

Fix the clarification answer-scanner treating engine-authored question
comments as answers (#909). `integrateClarificationAnswers` now filters
comments carrying a clarification-question marker *before* the author-trust
check, so a cluster's own question comment can no longer pass the trust gate
(under #910 the cluster identity is trusted) and be parsed as `Q<n>:` answers
— which caused the gate to see all questions as already answered. The four
engine question-marker dialects are consolidated into a single
`clarification-markers.ts` (`CLARIFICATION_QUESTION_MARKERS`,
`commentCarriesQuestionMarker`, `matchClarificationQuestionMarker`) with
line-anchored, case-sensitive matching so `> `-quoted markers in human answers
still integrate, and `isQuestionComment` delegates to the same predicate. The
untrusted-answer explainer now tells authors to re-post answers themselves in
the `Q1: <answer>` format.
