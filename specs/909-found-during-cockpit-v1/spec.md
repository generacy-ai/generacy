# Feature Specification: Marker-based exclusion in clarification answer-scanner + explainer copy fix

**Branch**: `909-found-during-cockpit-v1` | **Date**: 2026-07-10 | **Status**: Draft
**Source**: [generacy-ai/generacy#909](https://github.com/generacy-ai/generacy/issues/909) — found during cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92, finding #51)

## Summary

The clarification answer-scanner in `packages/orchestrator/src/worker/clarification-poster.ts` treats the engine's own **questions** comment (posted by the bot with `<!-- generacy-stage:clarification -->` marker and `### Q<n>: <topic>` headings) as a source of candidate **answers**. Today this produces a misleading operator-facing explainer ("Answers from @generacy-ai[bot] were not applied…must post or confirm"). Once finding #52 lands (App-identity clusters become trusted on the answer-scanner surface), the same mis-parse becomes trusted — the engine will silently self-answer clarification gates using its own question text. Today's trust rejection is the only thing masking a latent silent-corruption bug.

Companion to finding #52 (bot login unresolvable on App-identity clusters). **Ordering constraint**: this issue MUST land before #52. Bot-trust + marker-blind scanning = engine trusts its own questions comment and silently self-answers.

## Observed Behavior (christrudelpw/snappoll#4)

- Comment `4938943909` is the workflow's "## ❓ Clarification Questions — Batch 1" comment, marker `<!-- generacy-stage:clarification -->`, author `generacy-ai[bot]` (cluster App identity), body uses `### Q<n>: <topic>` headings with prose/backtick question bodies (no `**Question**:` / `**Context**:` bold markup).
- Author-trust check rejects the comment (tier `NONE` — see finding #52). Because the body matches `commentMatchesAnswerPattern` (`Q<N>:` at line start), the comment is pushed onto `skippedForExplainer` **before** any marker check runs.
- `postUntrustedAnswerExplainers` posts: *"Answers from @generacy-ai[bot] were not applied (association tier: `NONE`). A trusted member (OWNER/MEMBER/COLLABORATOR) must post or confirm the answers."*
- The cockpit auto session reads the explainer as authoritative and escalates the whole P1 clarification batch (Q1/Q2/Q3) to the operator.

### Three harms

1. **Misleading explainer** — no answers were ever posted by anyone; the "rejected answers" were the engine's own questions. Operator receives a false claim of a rejected answer set.
2. **Explainer copy references a nonexistent affordance** — "must post or **confirm**": grep confirms no confirm mechanism exists anywhere in the codebase. The only working path is a trusted member re-posting the answers. Same class as label-protocol "names that lie" findings.
3. **Latent silent corruption** — the moment finding #52 lands (bot login resolvable → cluster identity trusted on answer-scanner), this same mis-parse becomes *trusted*. Question topic text integrates into `clarifications.md` as answers and the clarification gate self-answers with garbage, no human in the loop. Today's trust rejection is the only thing stopping it.

## User Stories

### US1: Operator receives no false "rejected answers" explainer (P1)

**As an** operator running an auto-mode session on an App-identity cluster,
**I want** the clarification-poster to never post an "untrusted answers" explainer when the "answers" it detected were actually the engine's own questions comment,
**So that** I am not misled into escalating a batch that has no human-posted answers to review.

**Acceptance Criteria**:
- [ ] For the snappoll#4 fixture (informal batch comment, `<!-- generacy-stage:clarification -->` marker, `### Q<n>:` headings, no bold markup), zero explainer comments are posted regardless of author-trust decision.
- [ ] For an untrusted human comment matching `Q<N>:` (no engine marker), an explainer is still posted (existing behavior preserved).

### US2: Operator explainer copy names only affordances that exist (P1)

**As an** operator reading the "untrusted answer" explainer,
**I want** the copy to state only the real remediation path — a trusted member (OWNER/MEMBER/COLLABORATOR) must post the answers themselves in `Q1: A` format — and not offer a "confirm" verb the system cannot honor,
**So that** I am not directed to attempt an affordance that does not exist.

**Acceptance Criteria**:
- [ ] Explainer body text does not contain the substring "confirm".
- [ ] Explainer body text names the concrete re-post path with the `Q1: <answer>` format hint.

### US3: Once bot identity is trusted, engine cannot self-answer its own questions (P1, latent)

**As a** future cluster where the bot identity is trusted on the answer-scanner surface (post finding #52),
**I want** the engine's own clarification-questions comment to be excluded from the answer-parsing pipeline by deterministic marker match, not content sniff,
**So that** the engine cannot integrate its own question topics into `clarifications.md` as answers and self-close the clarification gate.

**Acceptance Criteria**:
- [ ] Same fixture as US1 with a trusted/self-authored author → zero answers parsed, zero updates to `clarifications.md`, gate remains open.
- [ ] Marker exclusion is trust-independent (identical result for trusted and untrusted authors).

### US4: Human-posted answers still integrate (P1, regression guard)

**As an** operator posting `Q1: A` on a clarification issue,
**I want** my answer integrated into `clarifications.md` as it is today,
**So that** the fix does not regress the primary happy path.

**Acceptance Criteria**:
- [ ] Trusted human comment `Q1: A` → integrated into `clarifications.md`, gate advances (unchanged from today).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-101 | Introduce a `commentCarriesQuestionMarker(body)` predicate that returns true iff the body contains any of: `<!-- generacy-stage:clarification -->`, `<!-- generacy-clarifications:`, `<!-- generacy-cockpit:clarifications-batch:`. | P1 | Deterministic marker match. Complements existing `isQuestionComment` (content-shape sniff). |
| FR-102 | On the answer-scanner surface (`integrateClarificationAnswers`), exclude any comment satisfying FR-101 **before** the author-trust decision — trust-independent and explainer-independent. | P1 | Prevents both the misleading explainer today (harm 1) and the silent self-answer post-#52 (harm 3). |
| FR-103 | Comments excluded by FR-102 must not be added to `skippedForExplainer` and must not receive an "untrusted answer" explainer comment. | P1 | Fixes harm 1 (misleading operator escalation). |
| FR-104 | Comments excluded by FR-102 must not enter `parseAnswersFromComments` regardless of trust tier. | P1 | Fixes harm 3 (latent silent corruption post-#52). |
| FR-105 | Update the untrusted-answer explainer copy: remove "or confirm"; state the real remediation (trusted member OWNER/MEMBER/COLLABORATOR must post the answers themselves in `Q1: <answer>` format). | P1 | Fixes harm 2 (names that lie). |
| FR-106 | Preserve FR-002 defense-in-depth: the `**Question**:`/`**Context**:` content-sniff inside `parseAnswersFromComments` remains for unmarked question-shaped text. | P1 | Belt-and-suspenders for future comment dialects that ship without the standard marker. |
| FR-107 | Emit a structured log line when a comment is excluded via FR-102, including `commentId`, `author`, and matched marker prefix. Body content is never logged (SC-007 discipline from existing surface). | P2 | Observability for near-misses without leaking issue content. |
| FR-108 | The FR-101 marker set must be represented as a single exported constant (or a single predicate) so future marker additions land in one place. | P2 | Ends the "multiple dialects, multiple check sites" drift called out in the bug body. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | For the snappoll#4-shape fixture (informal batch, `generacy-stage:clarification` marker, `### Q<n>:` headings, no bold markers), untrusted author → number of explainer comments posted | 0 | Unit test on `integrateClarificationAnswers` with a mock `github` client counting `addIssueComment` calls that include the `generacy-untrusted-answer:` marker. |
| SC-002 | Same fixture, trusted (or self-authored) author → number of answers integrated into `clarifications.md` | 0 | Unit test asserts `writeFileSync` is not called and `IntegrationResult.integrated === 0` with `reason === 'no-answers'`. |
| SC-003 | Trusted human comment `Q1: A` (no engine marker) → answer integrated | 1 | Existing behavior regression test — asserts `IntegrationResult.integrated === 1` and `clarifications.md` gains the answer. |
| SC-004 | Untrusted human comment `Q1: A` (no engine marker) → explainer posted | 1 | Existing behavior regression test — asserts `addIssueComment` called once with the `generacy-untrusted-answer:` marker. |
| SC-005 | The substring `confirm` in the explainer body | 0 occurrences | grep the string constant / snapshot test on the composed explainer body. |
| SC-006 | The explainer body includes the `Q1: <answer>`-style format hint | Present | String match on the composed explainer body. |
| SC-007 | Number of new call sites that hardcode a marker string (bypassing FR-108's single source) | 0 | Code review / grep for `<!-- generacy-` in `packages/orchestrator/src/worker/`. |
| SC-008 | Ordering invariant: `isTrustedCommentAuthor` on the answer-scanner surface is never invoked with a comment satisfying FR-101 | Enforced | Unit test with a spy on the trust helper — asserts it is not called for the marker-carrying fixture. |

## Assumptions

- The three marker prefixes named in FR-101 (`generacy-stage:clarification`, `generacy-clarifications:`, `generacy-cockpit:clarifications-batch:`) enumerate every current in-cluster clarification-question dialect. If a fourth marker exists, the FR-108 single-source constant makes it a one-line addition.
- The existing `isQuestionComment` check on `answerComments` (line 643 today) stays as a downstream belt for future dialects. FR-102 is the load-bearing early exclusion; `isQuestionComment` becomes redundant for marker-carrying comments (that's fine — cheap check).
- Finding #52 lands **after** this issue. If they merge in the wrong order, harm 3 becomes an active production bug on any App-identity cluster.
- No configuration surface (`.agency/comment-trust.yaml` widen list, per FR-008 of #842) affects the FR-102 exclusion — it is trust-agnostic and config-agnostic.
- The `clarify-resume` and `pr-feedback` surfaces (other callers of the trust helper) are **out of scope** here. Their existing behavior is unchanged. If they gain a similar "engine-authored questions comment" surface, they can adopt the FR-101 predicate as a follow-up.

## Out of Scope

- Fixing finding #52 (bot login resolution on App-identity clusters) — separate issue, ordering warning documented above.
- Adding a "confirm" mechanism (e.g., reaction-based approval of untrusted answers). The FR-105 fix removes the phantom verb from copy; adding the affordance is a separate design.
- Refactoring `isQuestionComment` to unify with the new FR-101 predicate. `isQuestionComment` covers content-shape sniff (no-marker fallback); FR-101 covers explicit-marker match. They have distinct semantics.
- Extending FR-101 marker exclusion to `clarify-resume` or `pr-feedback` surfaces.
- Backfilling a runtime schema for the marker set. String constants are sufficient at this scale.

## Regression Test Matrix

Follows the four cases from the bug body:

| # | Fixture | Author | Expected explainer | Expected integration |
|---|---------|--------|--------------------|-----------------------|
| 1 | Informal batch (`generacy-stage:clarification`, `### Q<n>:` headings, no `**Question**:` / `**Context**:` markup) | untrusted (App identity) | 0 | 0 |
| 2 | Same fixture as (1) | trusted / self-authored | 0 | 0 |
| 3 | Human `Q1: A` (no marker) | trusted (OWNER/MEMBER/COLLABORATOR) | 0 | 1 |
| 4 | Human `Q1: A` (no marker) | untrusted (NONE) | 1 | 0 |

All four cases must pass in a single unit test file to prevent the two-comment-dialect drift from re-emerging.

---

*Generated by speckit*
