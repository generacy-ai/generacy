# Contract: `PENDING_ANSWER_LITERAL` + `isPendingAnswerValue`

## Purpose

Collapse the current three-way divergence between prompt template (`[Leave empty for now]`), parser (`*Pending*`), and write-back regex (`*Pending*`) into a single shared constant. Make it structurally impossible for the three surfaces to disagree again.

Additionally: broaden the parser's tolerance so unknown placeholder shapes read as *pending* rather than *answered*. The current parser treats *only* the literal `*Pending*` as unanswered — an agent that follows its own prompt (`[Leave empty for now]`) marks every question answered and skips every gate.

## Exports

**Location**: `packages/orchestrator/src/worker/pending-literal.ts` (subject to relocation — see D1 below).

```ts
export const PENDING_ANSWER_LITERAL = '*Pending*';
export function isPendingAnswerValue(v: string): boolean;
```

## `PENDING_ANSWER_LITERAL` semantics

The canonical value the engine writes into `clarifications.md`'s `**Answer**:` field to signal "not yet answered." Exact string: `*Pending*` (asterisks are markdown italics; the parser treats the whole literal as an opaque token — it is NOT stripped to `Pending`).

## `isPendingAnswerValue` semantics

Returns `true` when the input `v` (post-trim, when appropriate) should be treated as an unanswered clarification value.

**Accepts (returns `true`):**

- Empty string.
- Whitespace-only (`v.trim() === ''`).
- The exact literal `*Pending*` (identity with `PENDING_ANSWER_LITERAL`).
- Any single-bracket placeholder: `v.trim()` matches `/^\[[^\]]*\]$/`.
  - Examples: `[Leave empty for now]`, `[TBD]`, `[TODO]`, `[]`.
  - The regex is deliberately shape-based, not case-based — the failure direction is "ask again" (spec design invariant #4).

**Rejects (returns `false`):**

- Real answers: `A`, `B`, `Some prose here.`, `**Q1**: A` (post-parse the outer `**Q1**:` structure is stripped elsewhere; the value passed here is the answer body only).
- Bracketed prefix + text: `[foo] bar` — the trailing text is a real answer.
- Multiple brackets: `[a][b]` — considered a real answer (unusual, deliberately not pending — better false positive than false negative).

## Consumers

### Prompt template (`packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts`)

Line ~55 changes from a plain string to a template that inlines `${PENDING_ANSWER_LITERAL}`:

```ts
// Before
**Answer**: [Leave empty for now]

// After
**Answer**: ${PENDING_ANSWER_LITERAL}
```

The prompt now tells the agent to write the *exact* string the parser looks for. No more "improvise the parser's literal and hope."

### Parser (`packages/orchestrator/src/worker/clarification-poster.ts`)

Two call sites:

- `parseClarifications` at L303 changes from `answerText !== '*Pending*'` to `!isPendingAnswerValue(answerText)`. Bracket-shaped values are now treated as unanswered — so if the agent misses the prompt template update and writes `[Leave empty for now]` (or any other bracketed value), the gate still holds.
- `parseAnswersFromComments` at L502 changes from `answer !== '*Pending*'` to `!isPendingAnswerValue(answer)`. When a human accidentally types `*Pending*` or `[TBD]` as an answer, it's treated as not-an-answer (correct — the failure direction is "ask again").

### Write-back regex (`packages/orchestrator/src/worker/clarification-poster.ts`)

L738 currently builds the regex literal:

```ts
const pattern = new RegExp(`(### Q${questionNum}:[\\s\\S]*?\\*\\*Answer\\*\\*:\\s*)\\*Pending\\*`);
```

After the change:

```ts
const pattern = new RegExp(
  `(### Q${questionNum}:[\\s\\S]*?\\*\\*Answer\\*\\*:\\s*)${escapeRegExp(PENDING_ANSWER_LITERAL)}`,
);
```

Adds a `escapeRegExp(s)` helper (or reuses one) since `PENDING_ANSWER_LITERAL` contains regex metacharacters. Emitted regex is byte-identical to today's; the change is that the literal is not spelled twice.

Note: the write-back regex only replaces the exact `PENDING_ANSWER_LITERAL`; it does NOT rewrite `[Leave empty for now]` placeholders. That's intentional — if a bracketed value ever appears in the file (a spec-authored file, a hand-edit), the write-back leaves it alone and the parser reads it as pending. Consistency of the failure direction.

### Cockpit answer-relay tool

`formatClarificationAnswerComment` in `packages/generacy/src/cli/commands/cockpit/clarification-answer-marker.ts` does NOT emit `PENDING_ANSWER_LITERAL` — its `answers` input is `Record<number, string>` with non-empty-string values enforced. A caller with no answer for `Q<n>` should omit that key; the tool refuses to render an empty `Q<n>:` line. This is deliberate: the answer-relay tool posts *answers*, not "still pending" placeholders.

## D1 — Import location

Two candidate homes:

- **A**: `packages/orchestrator/src/worker/pending-literal.ts`, exported from `@generacy-ai/orchestrator`. workflow-engine imports it.
- **B**: `packages/workflow-engine/src/actions/builtin/speckit/pending-literal.ts`, exported from `@generacy-ai/workflow-engine`. orchestrator imports it.

**Chosen: B** — orchestrator already depends on workflow-engine (`@generacy-ai/workflow-engine` types + client factory). A→B would invert the dependency graph and risk a cycle. cockpit (`@generacy-ai/generacy`) imports workflow-engine (for `WORKFLOW_LABELS` etc.), so it can import from the same package.

## SC-007 grep target

Post-fix, the following grep must return zero matches outside `pending-literal.ts` and its tests:

```
grep -rE '\*Pending\*|\[Leave empty for now\]' packages/*/src \
  --exclude-dir=__tests__ \
  --exclude=pending-literal.ts
```

Enforced in CI or a lightweight repo-hygiene test.

## Tests

- `isPendingAnswerValue`: table-driven — every accept/reject case listed above.
- Round-trip: `parseClarifications` of a file containing `**Answer**: ${PENDING_ANSWER_LITERAL}` returns `answered: false` for that question.
- Round-trip: prompt-template rendering with the fresh constant produces the exact byte sequence the parser recognizes as pending (integration).
- Grep test (SC-007): no divergent literals across `packages/*/src`.
