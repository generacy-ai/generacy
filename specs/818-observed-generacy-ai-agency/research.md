# Research: Clarify Phase Gate-Skip Race

**Issue**: [generacy-ai/generacy#818](https://github.com/generacy-ai/generacy/issues/818)
**Branch**: `818-observed-generacy-ai-agency`
**Status**: Complete

This document captures the decisions behind the plan. Each entry lists the alternatives considered, the rationale, and a code reference proving the decision is workable.

---

## D1: `isQuestionComment` rule — widest reliable question-side markup match

**Decision**: `isQuestionComment(body)` returns `true` when the body contains at least one `### Q<n>:` heading whose **section** (from the heading up to the next `### ` heading or end-of-body) contains ANY of `**Question**:`, `**Context**:`, or `**Options**:`. This is in addition to the existing 4-branch marker/heading detection (kept untouched).

**Why**:
- Live evidence from generacy-ai/agency#374: the bot's questions comment self-matched via its "How to answer" example block. The example is literally `Q1: your answer here` at line start, so line-anchor tightening alone (D3) is not enough — the parser needs to reject the WHOLE comment as an answer source first. That is `isQuestionComment`'s job.
- All three markup strings (`**Question**:`, `**Context**:`, `**Options**:`) are emitted by `formatComment()` on the bot side (`packages/orchestrator/src/worker/clarification-poster.ts:214-222`) but never appear in a well-formed human answer (`Q1: A — <text>`).
- Section-scoped check (not "anywhere in body") avoids a small false-positive tail: humans sometimes quote `**Question**:` in prose while replying — the section rule requires the markup to co-occur under a `### Q<n>:` heading, which is the exact shape of a bot question, not a human quote.

**Alternatives considered**:
- **A (`**Question**:` only)**: The loosest reliable signal. Rejected — Clarifications Q1 answered B because variant bot outputs may omit `**Question**:` when the Claude CLI condenses the format.
- **C (any `### Q<n>:` heading, no markup requirement)**: Rejected — humans could paste `### Q1: my answer follows` in a long reply and be classified as a bot comment, losing their answers.
- **D (any body containing both `### Q<n>:` AND `**Question**:` anywhere)**: Rejected — no section co-location. A human quoting `**Question**:` from the bot's comment plus writing `### Q1:` as a Markdown reply header would be misclassified.

**Reference**: `formatComment` in `clarification-poster.ts:198-238` always emits `### Q<n>:` + `**Context**:` + `**Question**:` in the same section, so option B catches every emitted-by-bot shape. Existing marker branches (`<!-- generacy-clarifications: -->` etc.) short-circuit before reaching the new rule, so no regression risk on the marker-matched case.

---

## D2: FR-002 defense-in-depth — content-based skip inside `parseAnswersFromComments`

**Decision**: Inside the answer-capture loop, after extracting `answer` text and BEFORE the `Skip placeholder text` check, add a rejection: if `answer.includes('**Question**:')` or `answer.includes('**Context**:')`, skip the integration for that Q and log `SKIPPED_SUSPICIOUS_ANSWER` at `warn` with `{ code, commentId, questionNumber, excerpt }`.

**Why**:
- Belt-and-suspenders behind FR-001. If `isQuestionComment` gets fooled by a further variant (e.g., a future template change), FR-002 catches the aftermath at the answer-parsing layer.
- The warn is the primary observability signal for SC-003 ("operator-visible warning fires when a suspicious answer integration is prevented"). Distinct code (per Clarifications Q2 option C) means log filtering can count near-misses independently from residual detections.
- Excerpt is truncated to 120 chars — enough to identify the offender, not enough to bloat log volume during a repeated poll cycle.

**Alternatives considered**:
- **Skip the FR-002 layer, rely solely on FR-001**: Rejected — Clarifications Q2 answered C (both warns), specifically because collapsing them loses the defense-working vs defense-failing distinction.
- **Match on any bold markup (`\*\*.+\*\*:`)** — Rejected as too broad; would false-positive on human answers that quote back a bold snippet.

**Reference**: `parseAnswersFromComments` current loop at `clarification-poster.ts:321-350`. The skip is a two-line addition immediately after `answer = extractEmbeddedAnswer(answer) ?? answer.trim()`.

---

## D3: FR-005 line-start anchoring for the `Q<n>:` regex

**Decision**: Replace the current regex

```
/(?:#{1,6}\s+)?(?:\*\*)?Q(\d+)(?:\*\*)?:\s*(.*?)(?=(?:\n(?:#{1,6}\s+)?(?:\*\*)?Q\d+(?:\*\*)?:)|$)/gs
```

with a version that anchors the `Q<n>:` opener at the **start of a line** (i.e., preceded by `^` or a newline, ignoring optional heading marker / bold wrap):

```
/(?:^|\n)(?:#{1,6}\s+)?(?:\*\*)?Q(\d+)(?:\*\*)?:\s*(.*?)(?=(?:\n(?:#{1,6}\s+)?(?:\*\*)?Q\d+(?:\*\*)?:)|$)/gs
```

**Why**:
- Second real vector: humans discussing an issue write things like "as per Q1: yes" mid-prose. Today's regex matches — Clarifications Q5 answered A (in scope), so we close it here.
- Single parsing mode for all comments (not partial per Q5 option C) — two parsing modes is two mechanisms for one job.
- The `(?:^|\n)` prefix is a non-capturing group and does not appear in the captured answer text, so the downstream `.trim()` and `extractEmbeddedAnswer` behaviour is unchanged.

**Alternatives considered**:
- **Use `m` flag and `^` anchor**: functionally equivalent but the current regex already uses `s` and `g` flags (dotall + global) and adding `m` changes `$` semantics in the lookahead. Explicit `(?:^|\n)` prefix is more surgical and easier to review.
- **Reject any comment containing mid-prose Q<n>: mentions entirely**: too aggressive — humans legitimately post `Q1: A` followed by explanatory prose that says "as per Q1: yes I mean A".

**Reference**: `parseAnswersFromComments` regex at `clarification-poster.ts:326-327`. Existing tests at `__tests__/clarification-poster.test.ts:406-660` cover `Q1: text` at line start — verified they still match under the new anchor.

---

## D4: Comment `id` plumbing — internal signature widening only

**Decision**: Change the internal function signature

```typescript
function parseAnswersFromComments(
  comments: Array<{ body: string }>,
  questionNumbers: number[],
): Map<number, string>
```

to

```typescript
function parseAnswersFromComments(
  comments: Array<{ id: number; body: string; created_at?: string }>,
  questionNumbers: number[],
  logger: Logger,
): Map<number, string>
```

and thread `logger` in for the FR-002 warn. Update the return shape to also surface the source-comment id per integrated answer (needed for FR-004's transition warn — see D5):

```typescript
Map<number, { answer: string; sourceCommentId: number; sourceHadQuestionHeadings: boolean }>
```

The `GitHubClient.getIssueComments` interface (`packages/workflow-engine/src/actions/github/client/interface.ts:133`) already returns `Comment[]` with `id` and `created_at`, so **no cross-package change is needed** — only the local `let comments: Array<{ body: string }>` narrowing in `integrateClarificationAnswers` (line ~405) is widened to match `Comment`.

**Why**:
- Clarifications Q4 answered A: real GitHub numeric id, not synthetic hash. Rationale: only option that lets an operator paste the id into a URL (`https://github.com/OWNER/REPO/issues/N#issuecomment-<id>`) and jump to the comment.
- No public API change means no downstream tests or callers break.
- Logger dependency injection matches the pattern already used by `integrateClarificationAnswers(context, logger)` — the module is already logger-aware.

**Alternatives considered**:
- **Return only `Map<number, string>` and pass the source comment id via a separate `Map<number, number>`**: doubles the data-structure surface for the same information. Rejected.
- **Do the FR-004 warn from `integrateClarificationAnswers` after the fact**: possible but requires re-scanning comments to find which one produced which answer — the parse function already has this information at capture time.

**Reference**: `Comment` at `packages/workflow-engine/src/types/github.ts:72-83` — `id: number`, `body: string`, `created_at: string` already present.

---

## D5: FR-004 residual-race detector — where the warn fires

**Decision**: The FR-004 warn (`TRANSITION_WITH_QUESTION_HEADINGS`) fires inside `integrateClarificationAnswers`, in the update loop that walks integrated answers. For each `[questionNum, { answer, sourceCommentId, sourceHadQuestionHeadings }]`:

- if `sourceHadQuestionHeadings === true` AND the answer actually transitions `*Pending*` → `<answer>` (i.e., the regex replace changes the content), log at `warn` with:
  - `code: 'TRANSITION_WITH_QUESTION_HEADINGS'`
  - `commentId: sourceCommentId`
  - `questionNumber: questionNum`
  - `answer: <first 120 chars>`
  - `issueNumber`

The `sourceHadQuestionHeadings` flag is set inside `parseAnswersFromComments` by a cheap `/(?:^|\n)###\s+Q\d+:/.test(comment.body)` check per comment.

**Why**:
- Semantic difference from FR-002 (per Clarifications Q2 C): FR-002 = defense working (a suspicious answer was rejected). FR-004 = defense failing (a suspicious integration happened anyway). Distinct codes make dashboards separable.
- Requires transition-actually-happened check (`updatedContent !== content`-per-Q) — a match that didn't change anything (because the question was already answered by an earlier comment) shouldn't fire the warn.
- The regex `.test()` for `### Q<n>:` is deliberately narrow — the FR-001 rule uses markup co-occurrence, but the FR-004 detector wants ANY `### Q<n>:` heading in the source comment. That way, even if a variant comment omits `**Question**:`/`**Context**:` and slips past FR-001, its `### Q<n>:` heading still trips FR-004 when the integration lands.

**Alternatives considered**:
- **Fire on any successful integration**: too noisy — every legitimate human-answer integration would warn.
- **Fire based on the FR-001 rule (markup section check)**: circular — if FR-001 rejected the comment, we never get here. FR-004 exists to catch the case where FR-001 said "not a question comment" but the comment nonetheless has `### Q<n>:` structure.

**Reference**: `integrateClarificationAnswers` at `clarification-poster.ts:372-451`. The transition point is the `updatedContent = updatedContent.replace(pattern, ...)` at line 437 — the fire point is one branch inside that loop.

---

## D6: Regression tests co-located and grouped by FR

**Decision**: Extend the existing `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`. Three new `describe` blocks:

- `describe('isQuestionComment — markup co-occurrence (FR-001)', ...)` covering (a) marker-absent + all-three-markup, (b) marker-absent + `**Question**:` only, (c) marker-absent + `**Context**:` only, (d) marker-absent + `**Options**:` only, (e) marker-absent + markup outside `### Q<n>:` section (must NOT match — negative).
- `describe('parseAnswersFromComments — line anchoring (FR-005, FR-008)', ...)` covering (a) `Q1: A` at line start (matches), (b) `as per Q1: yes` mid-prose (does NOT match).
- `describe('parseAnswersFromComments — suspicious answer skip (FR-002, US2)', ...)` covering (a) captured answer contains `**Question**:` → skipped, warn fired with `SKIPPED_SUSPICIOUS_ANSWER`; (b) captured answer contains `**Context**:` → skipped, warn fired.
- `describe('integrateClarificationAnswers — residual race warn (FR-004)', ...)` covering (a) comment has `### Q<n>:` heading but no markup → passes FR-001, passes FR-002 (no bold markup in the captured answer), gets integrated → warn fired with `TRANSITION_WITH_QUESTION_HEADINGS` and the real comment id; (b) comment is a normal human answer (no `### Q<n>:` heading) → does NOT warn.

**Why**:
- Co-locating with existing tests keeps the test surface for this module in one place.
- The four blocks map 1-to-1 to FR IDs, so a failing test surfaces which requirement regressed.
- Vitest `vi.spyOn(logger, 'warn')` assertions match the pattern used elsewhere in the file for observability tests.

**Reference**: existing `describe('isQuestionComment', ...)` block at `__tests__/clarification-poster.test.ts:664`. The new blocks extend, not replace.

---

## D7: What we deliberately did NOT do

- **FR-003 timestamp check**: dropped per Clarifications Q3 option C. Rationale documented in spec.md FR-003.
- **Cross-package interface changes**: the public `GitHubClient.getIssueComments()` already returns `Comment[]` with `id` — no interface change needed, only a local `let` type widening in `integrateClarificationAnswers`.
- **Broader phase-loop refactor**: out of scope per spec.md "Out of Scope".
- **Stage-comment-showing-complete UX bug**: this fix eliminates the state where the stage comment says "clarify complete" while `waiting-for:clarification` is still on the issue — so the UI bug becomes unreachable — but no direct code change in `stage-comment-manager.ts` is required.
