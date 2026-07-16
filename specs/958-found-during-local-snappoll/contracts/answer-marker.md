# Contract: Clarification Answer Marker

## Purpose

Declare a stable HTML-comment marker that distinguishes cluster-self-authored *answer* comments from cluster-self-authored *questions* comments — so the answer scanner can classify `viewerDidAuthor === true` comments correctly without free-text sniffing.

## Marker shape

- **Prefix**: `<!-- generacy-clarification-answers:`
- **Full header** (deterministic stamping): `<!-- generacy-clarification-answers:<batch> actor=<actor> ts=<iso8601> -->`
  - `<batch>` — non-negative integer
  - `actor=<actor>` — optional (omitted when the caller does not resolve an actor)
  - `ts=<iso8601>` — round-trip ISO-8601 string

## Match rule

`commentCarriesAnswerMarker(body: string): boolean`

- `body` is treated as `\n`-delimited.
- Returns `true` iff at least one line in `body` starts (at column 0) with a prefix from `CLARIFICATION_ANSWER_MARKERS`.
- Leading whitespace disqualifies (`  <!-- generacy-clarification-answers:1 -->` at column 2 → no match).
- Quote prefix disqualifies (`> <!-- generacy-clarification-answers:1 -->` at column 0 starts with `>`, not `<!--` → no match).
- Case-sensitive ASCII.
- Empty body → `false`.

## Marker set

```ts
export const CLARIFICATION_ANSWER_MARKERS: readonly string[] = [
  '<!-- generacy-clarification-answers:',
] as const;
```

Growth path: append a new prefix. All predicates iterate this array; no other file changes.

## Non-overlap with `CLARIFICATION_QUESTION_MARKERS`

The two arrays are pairwise disjoint (no member of one is a prefix of a member of the other). A comment whose body matches an answer marker cannot simultaneously match a question marker. If both predicates unexpectedly return `true` on the same comment (should never happen in practice), the answer-scanner treats the comment as a question — the failure direction is "not an answer source," per design invariant #4 (fail closed).

## Stamping surface

The marker MUST be written by deterministic code, never by an LLM/agent free-writing a comment.

- **Sole writer**: `formatClarificationAnswerComment` in `packages/generacy/src/cli/commands/cockpit/clarification-answer-marker.ts`.
- **Sole invocation surface**: `runClarifyRelay` in `packages/generacy/src/cli/commands/cockpit/clarify-relay.ts`, called by the `cockpit_relay_clarify_answers` MCP tool.
- **No prompt-side literal**: no skill file, no prompt template, no CLAUDE.md, no operations `clarify.ts`, no readme spells the marker literal. Agents that follow a prompt reproduce a marker at random (four different invented markers observed on #5/#6/#7/#8 within one run). Deterministic code writes it.

## Round-trip invariant

For every `marker` object satisfying `ClarificationAnswerMarker`'s validation:

- `commentCarriesAnswerMarker(formatClarificationAnswerComment(marker)) === true`
- `matchClarificationAnswerMarker(formatClarificationAnswerComment(marker)) === '<!-- generacy-clarification-answers:'`

Tested in `clarification-markers.test.ts` (matching predicate) and `clarification-answer-marker.test.ts` (stamping helper) via a shared fixture.

## Validation

`formatClarificationAnswerComment` throws `Error` on:

- `batch` not a non-negative integer.
- `actor` present and not matching `/^[A-Za-z0-9-]+$/`.
- `ts` not a string, not round-trip through `new Date().toISOString()`.
- `answers` empty map (no `Q<n>:` lines to emit).
- Any `answers` value being an empty string.

Callers (MCP tool boundary) return `status: 'error', class: 'invalid-args'` on `safeParse` failure of the outer Zod schema; the marker function's throws should not surface to the tool user (the Zod schema catches these upstream).
