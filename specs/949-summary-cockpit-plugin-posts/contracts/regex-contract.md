# Contract: Regex behavior for `parseAnswersFromComments`

**Feature**: #949 · **Module**: `packages/orchestrator/src/worker/clarification-poster.ts`

This contract enumerates the exact inputs and outputs that the widened parser MUST honor. Each row is directly assertable in `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts`. A PR that fails any row fails acceptance.

## `parseAnswersFromComments` — outer regex behavior

For each row, `comment.body` is passed to `parseAnswersFromComments(comments, [1, 2], logger)` where `[1, 2]` is the pending-questions filter. `answers.get(N)?.answer` is the expected extracted string.

| # | Input `comment.body` | `answers.get(1)?.answer` | `answers.get(2)?.answer` | Notes |
|---|---|---|---|---|
| 1 | `<!-- generacy-cockpit:clarification-answers -->\n\n### Q1\n**Answer:** A — Use the sealed file backend\n**Rationale:** It avoids a cloud round-trip.` | `A — Use the sealed file backend\nRationale: It avoids a cloud round-trip.` | `undefined` | Cockpit dialect, single block, with rationale (Q1→B join) |
| 2 | (as above with a second block:) `\n\n### Q2\n**Answer:** B\n**Rationale:** Because.` | `A — Use the sealed file backend\nRationale: It avoids a cloud round-trip.` | `B\nRationale: Because.` | **Load-bearing multi-question (Q4→A, terminator lockstep)** — Q2 must NOT be swallowed into Q1 |
| 3 | `### Q1\n**Answer:** X` (cockpit dialect, no rationale) | `X` | `undefined` | Q1→B fallthrough: no `**Rationale:**` line ⇒ just the answer value |
| 4 | `### Q1: Topic name\n**Answer: A** — description` | `A — description` | `undefined` | Engine/human dialect regression (m1) |
| 5 | `### Q1: Topic\n**Answer**: A` | `A` | `undefined` | Engine dialect, colon outside bold (m2) |
| 6 | `Q1: answer text` | `answer text` | `undefined` | Bare human dialect regression |
| 7 | `Some prose here.\nas per Q1: yes\nMore prose.` | `undefined` | `undefined` | **FR-005 negative** — mid-prose reference must NOT capture. Line-anchored |
| 8 | `Q1\n**Answer:** X` (bare line-start, no heading, no colon) | `undefined` | `undefined` | **Q2→A negative** — colon-less form REQUIRES heading |
| 9 | `### Q1\n**Answer:** X\n**Question**: leaked bot text` | `undefined` | `undefined` | **FR-002 negative** — leaked question markup ⇒ SKIPPED_SUSPICIOUS_ANSWER, no capture |
| 10 | `**Q1**: A` | `A` | `undefined` | Bold-wrapped colon-bearing form regression |

## `commentMatchesAnswerPattern` — boolean predicate behavior

For each row, `commentMatchesAnswerPattern(body)` MUST return the expected value.

| # | Input `body` | Expected | Notes |
|---|---|---|---|
| 1 | `### Q1\n**Answer:** X` | `true` | Cockpit dialect, colon-less — heading present, matches |
| 2 | `### Q1: Topic\n**Answer**: X` | `true` | Engine dialect regression |
| 3 | `Q1: answer` | `true` | Bare human dialect regression |
| 4 | `as per Q1: yes` | `false` | FR-005 — mid-prose reference must NOT match |
| 5 | `Q1\n**Answer:** X` (bare line-start, no heading, no colon) | `false` | Q2→A — colon-less form requires heading |
| 6 | `Random comment, no question ref.` | `false` | Baseline: unrelated comment does not fire the FR-013 explainer path |

## `extractEmbeddedAnswer` — nested extraction behavior

For each row, `extractEmbeddedAnswer(text)` MUST return the expected string.

| # | Input `text` (as captured by outer regex body) | Expected return | Notes |
|---|---|---|---|
| 1 | `\n**Answer:** A — Use the sealed file backend\n**Rationale:** It avoids a cloud round-trip.` | `A — Use the sealed file backend\nRationale: It avoids a cloud round-trip.` | m0 + rationale join (Q1→B) |
| 2 | `\n**Answer:** X` | `X` | m0 alone — no rationale ⇒ no join |
| 3 | `\n**Answer: A** — description` | `A — description` | m1 — engine dialect regression |
| 4 | `\n**Answer**: A` | `A` | m2 — engine dialect regression |
| 5 | `some other text` | `undefined` | No `**Answer**` markup at all |
| 6 | `\n**Answer:** X\n**Rationale:** Y\n**Answer:** Z` | `X\nRationale: Y` | m0 matches first `**Answer:**` occurrence per `/m` mode; rationale captured from following line. Multi-`**Answer:**` inside one block is an ill-formed cockpit body; deterministic-first-match is acceptable |

## FR-004 discriminator behavior (`sourceHadQuestionHeadings` at `:453`)

For each row, `parsed.sourceHadQuestionHeadings` for a captured Q1 answer MUST be the expected value.

| # | Input `comment.body` | Expected `sourceHadQuestionHeadings` | Notes |
|---|---|---|---|
| 1 | `### Q1\n**Answer:** X` | `false` | **Q5→C** — cockpit answer delimiter (no colon after Q1) is NOT a question heading. Do NOT fire `TRANSITION_WITH_QUESTION_HEADINGS` |
| 2 | `### Q1: Topic\n**Answer**: X` | `true` | Engine-authored question heading (colon present); FR-004 signal is legitimate |
| 3 | `### Q1\n**Answer:** X\n### Q2\n**Answer:** Y` | `false` | Multi-block cockpit — still no colons after Q<n>, still not question headings |

## `integrateClarificationAnswers` — end-to-end effect

Given `clarifications.md`:

```
### Q1: Rationale-line inclusion
**Answer**: *Pending*

### Q2: Opener strictness
**Answer**: *Pending*
```

and a trusted-author cockpit-format comment:

```
<!-- generacy-cockpit:clarification-answers -->

### Q1
**Answer:** A — Use the sealed file backend
**Rationale:** It avoids a cloud round-trip.

### Q2
**Answer:** A
**Rationale:** Heading requirement is safest.
```

The result MUST be `{ integrated: 2 }`. The persisted file MUST become:

```
### Q1: Rationale-line inclusion
**Answer**: A — Use the sealed file backend
Rationale: It avoids a cloud round-trip.

### Q2: Opener strictness
**Answer**: A
Rationale: Heading requirement is safest.
```

`logger.warn` MUST NOT be called with `code: 'TRANSITION_WITH_QUESTION_HEADINGS'` (FR-004 negative pin per Q5→C).

## Invariants

1. **Shared constant invariant** (Q3→A): the string `(?:^|\n)(?:(?:#{1,6}\s+(?:\*\*)?Q(\d+)(?:\*\*)?(?::\s*(.*))?)|(?:(?:\*\*)?Q(\d+)(?:\*\*)?:\s*(.*)))` (or its non-capturing variant) MUST NOT appear inline anywhere except at `QN_OPENER_PATTERN` / `QN_OPENER_PATTERN_NONCAPTURING`. Grep for it in review.

2. **Terminator lockstep invariant**: `QN_TERMINATOR_LOOKAHEAD` MUST accept the same set of next-opener shapes that `QN_OPENER_PATTERN` accepts as openers. A test that constructs a comment with a mid-block bare `Q1\n**Answer:** X` (which should NOT match either as an opener OR as a terminator) MUST be captured by the outer regex as part of the surrounding block's body, not as a new opener.

3. **FR-004 exclusion invariant** (Q5→C): the regex at `:453` MUST remain `/(?:^|\n)###\s+Q\d+:/` (colon present). A code comment MUST record why. Grep for `sourceHadQuestionHeadings` in review.

4. **Line-anchoring invariant** (FR-005): every arm of `QN_OPENER_PATTERN` MUST begin with `(?:^|\n)` — the leading anchor is shared by both disjunction arms.
