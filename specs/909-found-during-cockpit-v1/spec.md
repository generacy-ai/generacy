# Feature Specification: Found during the cockpit v1

**Branch**: `909-found-during-cockpit-v1` | **Date**: 2026-07-10 | **Status**: Draft

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #51 — first clarification gate on the fresh snappoll cluster (christrudelpw/snappoll, App-auth scaffold). Companion to finding #52 (bot login unresolvable on App-identity clusters); **the two mask each other — see the ordering warning before fixing either alone.**

## Observed (christrudelpw/snappoll#4)

The clarification answer-scanner (`packages/orchestrator/src/worker/clarification-poster.ts`) parsed the engine's **own questions comment** as candidate answers. Comment 4938943909 is the workflow's "## ❓ Clarification Questions — Batch 1" comment (`<!-- generacy-stage:clarification -->` marker, authored by the cluster App identity `generacy-ai[bot]`), formatted with `### Q<n>: <topic>` headings and prose/backtick question bodies. The scanner's `Q<n>:` regex captured 4 "answers" (topic + question text) from it:

- The FR-002 defense-in-depth sniff only skips captures containing `**Question**:` or `**Context**:` — this comment variant contains neither (the *formal* `<!-- generacy-clarifications:N -->` comment does, and is caught). Content sniffing is pinned to one comment dialect while the engine itself emits at least two.
- The comment-trust check then rejected the batch (author tier `NONE` — see finding #52) and posted the explainer: *"Answers from @generacy-ai[bot] were not applied (association tier: `NONE`). A trusted member (OWNER/MEMBER/COLLABORATOR) must post or confirm the answers."*

Two harms today, one latent:

1. **Misleading explainer** — no answers were ever posted by anyone; the "rejected answers" were the engine's own questions. The cockpit auto session read the explainer as authoritative and concluded the cluster cannot post clarification answers at all, escalating the whole P1 batch (#2/#3/#4) to the operator.
2. **Explainer copy references a nonexistent affordance** — "must post or **confirm**": grep confirms no confirm mechanism exists anywhere in the codebase; the only working path is a trusted member re-posting the answers. Operator-facing copy must not offer verbs the system cannot honor (same class as the label-protocol "names that lie" findings).
3. **Latent silent corruption** — the moment finding #52 lands (bot login resolvable → cluster identity trusted via comment-trust rule #1), this same mis-parse becomes *trusted*: question text integrates into `clarifications.md` as answers and the clarification gate self-answers with garbage, no human in the loop. Today's trust rejection is the only thing stopping it.

## Fix

1. **Marker-based exclusion before parsing**: skip any comment whose body carries a question-side marker (`<!-- generacy-stage:clarification -->`, `<!-- generacy-clarifications:`, `<!-- generacy-cockpit:clarifications-batch:`) — the engine knows its own wire format; excluding by marker is deterministic where content sniffing is dialect-fragile. Keep FR-002's sniff as defense-in-depth for unmarked question-shaped text.
2. **Fix the explainer copy**: state the real remediation — a trusted member (OWNER/MEMBER/COLLABORATOR) must post the answers themselves (`Q1: …` format) — and drop "or confirm" until a confirm mechanism exists.

## Ordering warning

Do not ship finding #52 (make the cluster's own identity trusted on the answer-scanner surface) before this issue's marker exclusion: bot-trust + marker-blind scanning = the engine trusts its own questions comment and silently self-answers clarification gates.

## Regression tests

- Fixture: the informal batch comment (`generacy-stage:clarification`, `### Q<n>:` headings, no bold markers) → zero candidate answers parsed, no explainer posted.
- Same fixture with a trusted/self-authored author → still zero (marker exclusion is trust-independent).
- Trusted human comment `Q1: A` → integrated (unchanged).
- Explainer body (when a genuinely untrusted human posts answers) names the re-post path only.


## User Stories

### US1: Engine questions are never mis-parsed as answers

**As a** cockpit auto-mode operator,
**I want** the clarification answer-scanner to skip comments the engine authored as questions,
**So that** a fresh cluster's own "Batch N" questions comment can never be captured as answer text — today (rejected by trust) or tomorrow (silently trusted once the cluster's own identity becomes trusted per finding #52).

**Acceptance Criteria**:
- [ ] Given a comment whose body contains any FR-101 marker at column 0 of any line, the scanner produces zero candidate answers from that comment and posts no rejection explainer.
- [ ] Behavior is trust-independent — the exclusion fires even if the comment author is OWNER/MEMBER/COLLABORATOR or the cluster's own identity.
- [ ] The snappoll#4 fixture (`<!-- generacy-stage:clarification-batch-1 -->` + `### Q<n>:` headings, no bold markers) yields zero candidate answers.

### US2: Explainer copy names only affordances the system honors

**As a** cockpit operator reading a "rejected answers" explainer,
**I want** the explainer to name only remediations that actually exist,
**So that** I don't waste time hunting for a "confirm" mechanism that isn't wired anywhere in the codebase.

**Acceptance Criteria**:
- [ ] The explainer body names re-posting by a trusted member (OWNER/MEMBER/COLLABORATOR) as the sole path.
- [ ] No occurrence of "or confirm" (or any confirm-verb variant) in the explainer template.

### US3: Trusted human answers still integrate

**As a** repo MEMBER answering a clarification batch,
**I want** my `Q1: A` / `Q2: B` reply to be integrated as before,
**So that** the exclusion doesn't regress the happy path.

**Acceptance Criteria**:
- [ ] A trusted human comment with `Q1: <answer>` lines and no engine marker is parsed and integrated exactly as today.

### US4: Quoted-marker human replies still integrate

**As a** repo MEMBER whose reply quotes the questions comment (`> <!-- ... -->` + `> ### Q1: ...`) above the actual answers,
**I want** my answers integrated,
**So that** the natural GitHub reply-with-quote pattern doesn't cause silent answer loss.

**Acceptance Criteria**:
- [ ] Markers are matched only at column 0 of a line; `> `-quoted markers do not trigger exclusion.
- [ ] The reply's `Q<n>: <answer>` lines below the quoted block are parsed and integrated.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-101 | Introduce a marker set covering every engine-authored question dialect: `<!-- generacy-stage:clarification`, `<!-- generacy-clarifications:`, `<!-- generacy-cockpit:clarifications-batch:`. Match by **prefix substring** (case-sensitive, ASCII) so future variants like `-batch-1` are covered by construction (clarify Q1 → B). | P1 | Explicit dialects observed: `generacy-stage:clarification`, `generacy-stage:clarification-batch-1`, `generacy-clarifications:`, `generacy-cockpit:clarifications-batch:`. |
| FR-102 | The answer-scanner in `clarification-poster.ts` MUST skip any comment whose body carries any FR-101 marker **at column 0 of any line** — before any candidate-answer regex runs. | P1 | Column-0 rule (clarify Q3 → B) admits human `> `-quoted markers while excluding engine-authored bodies. |
| FR-103 | Exclusion in FR-102 is **trust-independent**: it fires regardless of comment `author_association`, including when the cluster's own identity becomes trusted (finding #52 landing). | P1 | Blocks the "silent self-answer" latent harm. |
| FR-104 | The rejection explainer template MUST name only the re-post remediation (a trusted member OWNER/MEMBER/COLLABORATOR posting the answers as `Q1: …`) and MUST NOT contain "or confirm" or any confirm-verb variant. | P1 | Copy-only change; no new affordance. |
| FR-105 | Ship this marker-exclusion change **before** finding #52 (bot-trust) lands — the ordering warning in the Fix section is a build-order constraint, not commentary. | P1 | Enforced by co-ordination between #909 and generacy-ai/generacy#910. |
| FR-106 | Preserve the existing content-shape sniff (FR-002 style) inside `parseAnswersFromComments` as belt-and-suspenders for unmarked question-shaped text. | P2 | Marker exclusion is primary; content sniff is defense-in-depth. |
| FR-107 | Emit one structured log line on marker-based exclusion at **debug** level, shape: `logger.debug({ event: 'clarification-answer-scanner-marker-excluded', commentId, author, markerPrefix, issueNumber }, 'Excluded from answer-scanner via question marker')`. Comment body is never logged. | P2 | Debug level (clarify Q5 → B) because exclusion is steady-state per poll cycle; info would flood logs. |
| FR-108 | The marker set + predicate live in a new dedicated module `packages/orchestrator/src/worker/clarification-markers.ts`, exporting `CLARIFICATION_QUESTION_MARKERS` and `commentCarriesQuestionMarker(body)`. Future marker additions land in exactly one place. | P1 | Clarify Q4 → B. Named upcoming consumer: #910 clarify-resume surface. No cross-package lift yet. |
| FR-109 | `isQuestionComment` at `clarification-poster.ts:210-233` MUST call `commentCarriesQuestionMarker(body)` as its first branch; the three inline `.includes()` calls at lines 212–216 are deleted. Content-shape branches (`### Q<n>:` split + `**Question**:` etc.) stay. | P1 | Clarify Q2 → B (delegate). Makes FR-108's "single source" true of the whole file. |
| FR-110 | Regression coverage MUST assert wiring at the `parseAnswersFromComments` integration seam — not only the predicate in isolation — because this finding exists precisely because `isQuestionComment` existed but wasn't called on the scan path. | P1 | Prevents recurrence-by-oversight. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | snappoll#4 fixture (informal batch comment: `generacy-stage:clarification-batch-1` marker + `### Q<n>:` headings, no `**Question**:` bold markers) yields **zero** candidate answers. | 0 candidates | Unit test in `clarification-poster.test.ts` asserting `parseAnswersFromComments(fixture)` returns `[]`. |
| SC-002 | Same fixture with author association set to OWNER/MEMBER (or the cluster's own identity when trusted) still yields zero candidate answers and posts no explainer. | 0 candidates, 0 explainers | Trust-independence unit test. |
| SC-003 | Trusted human comment `Q1: A\nQ2: B` with no engine marker is integrated exactly as before this change. | 2 answers integrated | Regression test against pre-change behavior. |
| SC-004 | Trusted human comment quoting the questions (`> <!-- generacy-stage:clarification -->\n> ### Q1: Topic\n\nQ1: A\nQ2: B`) has its `Q1: A` / `Q2: B` answers integrated (not silently dropped by exclusion). | 2 answers integrated | US4 regression test. |
| SC-005 | The rejection explainer body contains zero occurrences of "or confirm" or any confirm-verb variant. | 0 matches | grep guard in tests. |
| SC-006 | The explainer names the trusted-member re-post path as the sole remediation. | Present | Snapshot/string test on explainer template. |
| SC-007 | No file under `packages/orchestrator/src/worker/` hardcodes a marker string from FR-101 outside of `clarification-markers.ts`; `isQuestionComment` no longer contains the three inline `.includes()` at lines 212–216. | 0 offending call sites | grep guard in a lint-style test. |
| SC-008 | On exclusion, exactly one debug log line is emitted with fields `event`, `commentId`, `author`, `markerPrefix`, `issueNumber`; no field carries the comment body. | 1 line, correct shape | Logger spy in unit test. |

## Assumptions

- Comment-trust check and downstream `Q<n>:` parsing behavior for trusted human answers remain unchanged.
- Marker prefixes are stable engine-emitted constants; no cross-repo/cross-locale variants exist.
- The clarify-resume surface (#910) will consume the FR-108 exports directly rather than duplicating the predicate.
- Column-0 line detection uses standard `\n`-split; markdown block-quote (`>`) is the only realistic quoted-marker source.

## Out of Scope

- Introducing an actual "confirm" affordance (would require new UI/protocol surface — deferred).
- Making the cluster's own identity trusted on the answer-scanner surface (that is finding #52 / generacy-ai/generacy#910; this issue's exclusion MUST land first per FR-105).
- Refactoring the posting-marker constant (`MARKER_PREFIX` used by `clarificationMarker()`) — separate marker family, left in place.
- Lifting the marker constant/predicate to `@generacy-ai/workflow-engine` or a new shared package (revisit when a second package needs it).

---

*Generated by speckit*
