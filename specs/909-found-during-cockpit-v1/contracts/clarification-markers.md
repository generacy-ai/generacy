# Contract: `clarification-markers.ts` module

**Location**: `packages/orchestrator/src/worker/clarification-markers.ts` (new file)

## Public API

### `CLARIFICATION_QUESTION_MARKERS: readonly string[]`

Ordered list of prefix strings identifying engine-authored clarification-question comments.

Every entry is:
- A stable engine-emitted HTML-comment prefix.
- Namespaced under `<!-- generacy-`.
- Case-sensitive ASCII.
- Pairwise non-identical (no entry is a substring of another's semantics; see data-model.md invariants).

Current entries (order = FR-101 declaration order):

| Index | Prefix | Emitted by |
|-------|--------|------------|
| 0 | `<!-- generacy-stage:clarification` | stage tracker (covers `-->`, `-batch-1 -->`, future variants) |
| 1 | `<!-- generacy-clarifications:` | orchestrator `postClarifications()` (issue-scoped) |
| 2 | `<!-- generacy-clarification:` | CLI clarify operation (batch-scoped) |
| 3 | `<!-- generacy-cockpit:clarifications-batch:` | cockpit clarify-batch surface |

**Extension protocol**: appending a new prefix to this array is the sole required change to add a new engine dialect. Callers, tests, and the FR-107 log line pick up the addition automatically.

### `commentCarriesQuestionMarker(body: string): boolean`

Returns `true` iff any line of `body` (delimited by `\n`) begins with any prefix in `CLARIFICATION_QUESTION_MARKERS`.

**Column-0 rule** (clarify Q3→B): only matches when the prefix appears at position 0 of the line — leading whitespace or `> ` block-quote prefix disqualifies the line.

**Cases**:

| Input | Output |
|-------|--------|
| `''` | `false` |
| `'hello world'` | `false` |
| `'<!-- generacy-stage:clarification -->\n### Q1: ...'` | `true` |
| `'<!-- generacy-stage:clarification-batch-1 -->\n### Q1: ...'` | `true` |
| `'<!-- generacy-clarifications:42 -->\n## Clarification Questions'` | `true` |
| `'<!-- generacy-cockpit:clarifications-batch:1 -->\n...'` | `true` |
| `'  <!-- generacy-stage:clarification -->'` (leading whitespace) | `false` |
| `'> <!-- generacy-stage:clarification -->\n\nQ1: A'` (quoted) | `false` |
| `'preamble\n<!-- generacy-clarifications:42 -->\nrest'` (not first line) | `true` |
| `'<!-- generacy-untrusted-answer:5 -->'` (different family) | `false` |
| `'<!-- generacy-stage:specification -->'` (different stage — no `:clarification` suffix at prefix boundary) | `false` |

### `matchClarificationQuestionMarker(body: string): string | undefined`

Same semantics; returns the exact prefix string that matched (identity from `CLARIFICATION_QUESTION_MARKERS`) or `undefined`.

Match order: outer loop over lines (`body.split('\n')`) in source order; inner loop over `CLARIFICATION_QUESTION_MARKERS` in declaration order. First hit returns.

## Non-public / internal

None. The module has no state, no I/O, no side effects.

## Test contract (`__tests__/clarification-markers.test.ts`)

Coverage requirements:

1. Every prefix in `CLARIFICATION_QUESTION_MARKERS` matches its own literal at column 0.
2. The `-batch-1` variant on prefix 0 matches (proves prefix-substring semantics, SC-001 dependency).
3. Column-0 rule: `> ` quote → `false`; leading space → `false`; leading tab → `false`.
4. Multi-line body with marker on any line (first / middle / last) → `true`.
5. Empty string → `false`.
6. `matchClarificationQuestionMarker` returns the exact prefix in `CLARIFICATION_QUESTION_MARKERS` (identity via `.indexOf` in the assertion).
7. Adding a hypothetical unknown marker prefix to the input body does not match (regression guard).

## Downstream contract

**Consumers** (in-tree):

- `clarification-poster.ts::isQuestionComment` — calls `commentCarriesQuestionMarker` as first branch (FR-109).
- `clarification-poster.ts::integrateClarificationAnswers` — calls `matchClarificationQuestionMarker` as the FR-102 pre-filter, uses the returned prefix in the FR-107 debug log's `markerPrefix` field.

**Consumers** (planned, out of scope for #909):

- `#910` clarify-resume surface — will import `commentCarriesQuestionMarker` directly (Q4→B rationale).

## Non-goals

- Pattern flexibility (regex, glob, etc.) — deliberate; the marker set is a compile-time constant.
- Cross-package export from `@generacy-ai/workflow-engine` — deferred until a second package needs it (spec Out-of-Scope §).
- Case-insensitive matching — engine-emitted constants, ASCII stable.
