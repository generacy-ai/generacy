# Data Model: Clarify Phase Gate-Skip Race

**Issue**: [generacy-ai/generacy#818](https://github.com/generacy-ai/generacy/issues/818)
**Branch**: `818-observed-generacy-ai-agency`
**Status**: Complete

Only three data shapes change in this fix — all internal to `packages/orchestrator/src/worker/clarification-poster.ts`. No public types (Zod schemas, exported interfaces) added; no cross-package type changes. The `Comment` shape at `packages/workflow-engine/src/types/github.ts:72-83` is reused verbatim.

---

## 1. Widened `parseAnswersFromComments` input

**Before** (`clarification-poster.ts:315-318`):

```typescript
function parseAnswersFromComments(
  comments: Array<{ body: string }>,
  questionNumbers: number[],
): Map<number, string>
```

**After**:

```typescript
function parseAnswersFromComments(
  comments: Array<{ id: number; body: string; created_at?: string }>,
  questionNumbers: number[],
  logger: Logger,
): Map<number, ParsedAnswer>
```

Where the new `ParsedAnswer` shape carries the source-comment metadata needed for the FR-004 residual-race warn:

```typescript
interface ParsedAnswer {
  /** The extracted answer text, post-trim + post-extractEmbeddedAnswer */
  answer: string;
  /** The GitHub numeric id of the comment this answer was captured from */
  sourceCommentId: number;
  /** true if the source comment body contains at least one `### Q<n>:` heading */
  sourceHadQuestionHeadings: boolean;
}
```

**Validation rules**:
- `id` MUST be a positive integer — comes directly from the GitHub API via `getIssueComments()`, no additional validation.
- `answer` MUST be non-empty and not equal to `*Pending*` (existing behaviour, preserved).
- `answer` MUST NOT contain `**Question**:` or `**Context**:` markup — new FR-002 rule; violating answers are skipped with a `SKIPPED_SUSPICIOUS_ANSWER` warn and never enter the map.

**Relationships**:
- Consumed by `integrateClarificationAnswers()`, which iterates `Map<number, ParsedAnswer>` to write the file and to emit the FR-004 warn.
- The `comments` array is directly the return value of `github.getIssueComments()` (`Comment[]` at `packages/workflow-engine/src/types/github.ts:72`) — the local `let comments: Array<{ body: string }>` narrowing at `clarification-poster.ts:405` is widened to `Array<{ id: number; body: string; created_at?: string }>` to preserve the field.

---

## 2. `isQuestionComment` — new detection branch

The function retains its `(body: string) => boolean` signature. Internally, after the four existing marker/heading checks, a new branch:

```typescript
function isQuestionComment(body: string): boolean {
  // ... existing branches (marker, CLI marker, stage marker, heading) unchanged ...

  // FR-001: any `### Q<n>:` heading whose section contains question-side markup
  const sections = splitByQuestionHeading(body);
  for (const section of sections) {
    if (
      section.includes('**Question**:') ||
      section.includes('**Context**:') ||
      section.includes('**Options**:')
    ) {
      return true;
    }
  }

  return false;
}
```

Helper (new, private, un-exported):

```typescript
/**
 * Split a comment body into sections keyed by `### Q<n>:` headings.
 * Each section spans from a heading to the next `### ` heading (or EOF).
 * Returns an empty array if no `### Q<n>:` heading is present.
 */
function splitByQuestionHeading(body: string): string[] {
  const headingPattern = /^### Q\d+:.*$/gm;
  const headings = [...body.matchAll(headingPattern)];
  if (headings.length === 0) return [];

  const sections: string[] = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i]!.index!;
    const nextTopLevelHeading = body
      .slice(start + headings[i]![0].length)
      .search(/^### /m);
    const end =
      nextTopLevelHeading === -1
        ? body.length
        : start + headings[i]![0].length + nextTopLevelHeading;
    sections.push(body.slice(start, end));
  }
  return sections;
}
```

**Validation rules**:
- Section boundary is `^### ` (any level-3 heading, not only `### Q<n>:`), so a subsequent `### Q<n>:` closes the previous section.
- Section markup match is case-sensitive (matches the exact strings emitted by `formatComment`).

---

## 3. Log payload contracts

Two new `warn`-level log entries. Both are structured JSON-like objects passed to `pino` — no free-form strings.

### 3a. `SKIPPED_SUSPICIOUS_ANSWER` (FR-002)

Fires inside `parseAnswersFromComments` when a captured answer is rejected for containing `**Question**:` / `**Context**:` markup.

```typescript
logger.warn(
  {
    code: 'SKIPPED_SUSPICIOUS_ANSWER',
    commentId: comment.id,
    questionNumber,
    excerpt: answer.slice(0, 120),
  },
  'Skipped suspicious clarification answer (contains question-side markup)',
);
```

Contract file: [`contracts/log-skipped-suspicious-answer.schema.json`](./contracts/log-skipped-suspicious-answer.schema.json).

### 3b. `TRANSITION_WITH_QUESTION_HEADINGS` (FR-004)

Fires inside `integrateClarificationAnswers` when a `*Pending*` → `<answer>` transition is written to the file from a source comment that contains `### Q<n>:` heading(s).

```typescript
logger.warn(
  {
    code: 'TRANSITION_WITH_QUESTION_HEADINGS',
    commentId: parsed.sourceCommentId,
    issueNumber,
    questionNumber,
    answer: parsed.answer.slice(0, 120),
  },
  'Integrated answer from a comment containing question headings — possible bot self-answer',
);
```

Contract file: [`contracts/log-transition-with-question-headings.schema.json`](./contracts/log-transition-with-question-headings.schema.json).

---

## 4. Untouched shapes (for reference)

The following existing shapes are consumed by the fix but not altered:

- `ClarificationQuestion` (`clarification-poster.ts:49-64`) — read via `parseClarifications`, no change.
- `IntegrationResult` (`clarification-poster.ts:356-361`) — return shape of `integrateClarificationAnswers`, no change.
- `Comment` (`packages/workflow-engine/src/types/github.ts:72`) — already has `id: number` and `created_at: string`.
- `Logger` (from `./types.js`) — no change; the module already receives a logger via `integrateClarificationAnswers(context, logger)`.

---

## 5. State transitions

The gate evaluation state machine is unchanged. The fix narrows the input filtering (fewer false-positive integrations), which biases the state machine toward the correct `gateActive === true` branch when questions are truly pending.

```
                    +-------------------------+
                    | phase-loop enters 5c    |
                    | (after commit + labels) |
                    +-----------+-------------+
                                |
                                v
              +----------------------------------+
              | gateChecker.checkGates('clarify')|
              +----------------+-----------------+
                               |
                               v (gate has condition 'on-questions')
      +--------------------------------------------+
      | integrateClarificationAnswers(ctx, log)    |
      | -------- FR-001 / FR-002 / FR-005 --------  |
      | filter question comments (widened)          |
      | parse answers with anchored regex           |
      | skip suspicious answers → WARN (FR-002)     |
      | integrate + WARN if source had Q-headings   |
      |   (FR-004)                                  |
      +----------------+---------------------------+
                       |
                       v
      +----------------------------------+
      | hasPendingClarifications(...)    |
      +----------------+-----------------+
              |                    |
   (has pending)              (no pending)
              |                    |
              v                    v
      gate ACTIVATES         gate SKIPPED (correct)
      → add waiting-for      → phase-loop proceeds
      → pause worker
```
