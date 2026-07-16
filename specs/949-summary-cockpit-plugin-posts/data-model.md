# Data Model: Widen the deterministic clarification-answer parser to accept the cockpit dialect

**Feature**: #949 · **Branch**: `949-summary-cockpit-plugin-posts`

This change is a targeted regex fix inside a single module. There are no wire-protocol changes, no schema changes, no new types exported from `@generacy-ai/orchestrator`. This document pins the internal shapes so the implementer cannot accidentally widen the surface.

## Constants

### `QN_OPENER_PATTERN` (raw pattern string, module-local)

```
(?:^|\n)(?:(?:#{1,6}\s+(?:\*\*)?Q(\d+)(?:\*\*)?(?::\s*(.*))?)|(?:(?:\*\*)?Q(\d+)(?:\*\*)?:\s*(.*)))
```

- **Type**: `string` (raw pattern; NOT `RegExp` — composed into three sites with different suffixes).
- **Anchoring**: line-start (`^` or preceding `\n`) — FR-005 preserved.
- **Two arms** (disjunction):
  - Colon-less: requires `#{1,6}\s+` heading prefix (Q2→A). Q number captured in group **1**. Optional trailing `: topic` captured in group **2**.
  - Colon-bearing: heading optional. Q number captured in group **3**. Trailing text captured in group **4**.
- **Consumer helper**:
  ```ts
  function pickQnMatch(m: RegExpExecArray): { qn: number; trailing: string } {
    const num = m[1] ?? m[3];
    const trail = m[2] ?? m[4] ?? '';
    return { qn: parseInt(num!, 10), trailing: trail };
  }
  ```

### `QN_OPENER_PATTERN_NONCAPTURING` (raw pattern string, module-local)

Same grammar as `QN_OPENER_PATTERN`, but every `(\d+)` numeric-capture group replaced with `(?:\d+)`, and every `(.*)` trailing group replaced with `(?:.*)`. Used only in `commentMatchesAnswerPattern`, which needs a boolean predicate and no captures.

### `QN_TERMINATOR_LOOKAHEAD` (raw pattern string, module-local)

```
(?=(?:\n(?:(?:#{1,6}\s+(?:\*\*)?Q\d+(?:\*\*)?(?::.*)?)|(?:(?:\*\*)?Q\d+(?:\*\*)?:.*)))|$)
```

- **Type**: `string`.
- **Purpose**: block terminator for the outer regex in `parseAnswersFromComments`.
- **Key difference from `QN_OPENER_PATTERN`**: leading `\n` REQUIRED (no `^` alternation) so it cannot re-anchor mid-line inside a body's own content.
- **Coupling invariant**: MUST accept the same set of next-opener shapes as `QN_OPENER_PATTERN` accepts as openers. If future work adds a new opener shape (e.g., `**Q1**` colon-less), both this and `QN_OPENER_PATTERN` must be updated together.

## Types (unchanged)

### `ParsedAnswer` (module-local, `clarification-poster.ts:422-429`)

```ts
interface ParsedAnswer {
  /** The extracted answer text. */
  answer: string;
  /** The GitHub numeric id of the comment this answer was captured from. */
  sourceCommentId: number;
  /** true if the source comment body contains at least one `### Q<n>:` heading (colon required — FR-004 discriminator). */
  sourceHadQuestionHeadings: boolean;
}
```

**No shape change.** Q1→B rationale-line join is encoded inside the `answer: string` field:

- Cockpit dialect with rationale: `answer = "<answer-value>\nRationale: <rationale-value>"`.
- Cockpit dialect without rationale: `answer = "<answer-value>"`.
- Engine dialect: `answer = "<answer-value>"` (unchanged from today).
- Bare human dialect: `answer = "<answer text>"` (unchanged from today).

The consumer at `phase-loop.ts` and `clarifications.md`'s persisted content both accept a single string — the join happens inside `extractEmbeddedAnswer` and does not require any downstream change.

### `IntegrationResult` (module-local, `clarification-poster.ts:507-512`)

```ts
interface IntegrationResult {
  integrated: number;
  reason?: 'no-spec-dir' | 'no-file' | 'no-pending' | 'no-answers' | 'no-changes';
}
```

**No shape change.** The observable behavior change is: for a cockpit-shaped answer comment where today `integrated=0, reason='no-answers'` is returned, after the fix `integrated=N` (where N is the number of Q blocks with matching pending questions).

## Validation rules

- **`QN_OPENER_PATTERN` MUST compile as a `RegExp`** at module load. Bad pattern surfaces at import-time, not request-time.
- **`QN_OPENER_PATTERN` MUST NOT be reused** for `sourceHadQuestionHeadings` at `:453`. That pattern's colon is load-bearing (Q5→C) and folding it into the shared constant would break FR-004.
- **`QN_OPENER_PATTERN` MUST be composed into all THREE sites** listed in Design §"The shared opener constant" (outer opener, outer terminator lookahead, `commentMatchesAnswerPattern`). A PR that leaves two duplicated inline regexes fails acceptance (Q3→A).
- **Capture-group indices are stable** across the disjunction:
  - Group 1: Q number (colon-less arm)
  - Group 2: topic-or-trailing (colon-less arm)
  - Group 3: Q number (colon-bearing arm)
  - Group 4: trailing (colon-bearing arm)
  - Group 5 (added by outer regex): the block body captured between opener and terminator.
- **The outer regex MUST use `g` and `s` flags** (`gs`) to iterate blocks and dot-match newlines inside the body capture.

## Relationships

```
commentMatchesAnswerPattern
      └── uses QN_OPENER_PATTERN_NONCAPTURING (boolean predicate; no captures)

parseAnswersFromComments (outer regex)
      ├── uses QN_OPENER_PATTERN (with numeric captures)
      └── uses QN_TERMINATOR_LOOKAHEAD (post-body; boolean-only lookahead)
              │
              └── invariant: accepts the same next-opener shapes as QN_OPENER_PATTERN accepts as openers

sourceHadQuestionHeadings (FR-004 discriminator)
      └── uses INLINE /(?:^|\n)###\s+Q\d+:/ (colon REQUIRED; deliberately not shared)

extractEmbeddedAnswer
      ├── m0: /\*\*Answer:\*\*\s*(.+?)$/m               # cockpit dialect — colon INSIDE bold
      │       └── if match: also runs /\n\*\*Rationale:\*\*\s*(.+?)$/m and joins (Q1→B)
      ├── m1: /\*\*Answer:\s*(.+?)\*\*(.*)$/m           # engine dialect — colon INSIDE bold, close-** anywhere
      └── m2: /\*\*Answer\*\*:\s*(.+)$/m                # engine dialect — colon OUTSIDE bold
```

## Fixture inventory

All fixtures live in `packages/orchestrator/src/worker/__tests__/clarification-poster.test.ts` (append; new fixture constants near the top of the file):

| Constant | Shape | Positive/negative | Load-bearing? |
|---|---|---|---|
| `FIXTURE_COCKPIT_MULTI` | Real captured `### Q1\n**Answer:** X\n**Rationale:** Y\n\n### Q2\n…` (≥ 2 blocks) | Positive integration | **Yes** (Q4→A MUST; also pins terminator lookahead) |
| `FIXTURE_COCKPIT_SINGLE` | `### Q1\n**Answer:** X\n**Rationale:** Y` (1 block) | Positive integration | No |
| `FIXTURE_ENGINE_HEADING` | `### Q1: Topic\n**Answer: A** — text` | Positive integration | Yes (regression) |
| `FIXTURE_ENGINE_ANSWER_COLON_OUTSIDE` | `### Q1: Topic\n**Answer**: A` | Positive integration | Yes (regression) |
| `FIXTURE_BARE_HUMAN` | `Q1: answer text` | Positive integration | Yes (regression) |
| `FIXTURE_MID_PROSE` | `text\nas per Q1: yes\nmore text` | Negative — must NOT capture | Yes (FR-005) |
| `FIXTURE_BARE_LINE_START_NO_HEADING` | `Q1\n**Answer:** X` | Negative — must NOT open a block | Yes (Q2→A) |
| `FIXTURE_LEAKED_QUESTION` | `### Q1\n**Answer:** X\n**Question**: leaked bot text` | Negative — must SKIP (FR-002) | Yes (FR-002) |
| `FIXTURE_COCKPIT_UNTRUSTED_AUTHOR` | Cockpit-shaped body posted by an untrusted author | Positive — must produce explainer | Yes (FR-013) |
| `FIXTURE_COCKPIT_FR004_NEGATIVE` | Well-formed cockpit body (same shape as `FIXTURE_COCKPIT_MULTI` or SINGLE) integrated by a trusted author | Negative — must NOT emit `TRANSITION_WITH_QUESTION_HEADINGS` | Yes (Q5→C) |

`FIXTURE_COCKPIT_MULTI` and `FIXTURE_COCKPIT_FR004_NEGATIVE` MAY be the same string.

## Non-goals (schemas explicitly not touched)

- `ClarificationPostResult` — unchanged.
- `commentCarriesQuestionMarker`, `matchClarificationQuestionMarker` — unchanged (upstream question-side markers).
- `CommentTrustContext` — unchanged.
- `formatComment` (`:341`) — unchanged; the engine still emits `### Q<n>: Topic\n**Answer**: *Pending*` into `clarifications.md`.
- The write-back regex at `:730-732` — unchanged (targets the engine-dialect file content, not comment bodies).
