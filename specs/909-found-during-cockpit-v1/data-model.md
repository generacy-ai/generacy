# Data Model: Marker-based exclusion in clarification answer-scanner (#909)

This change is primarily behavioral; the data model additions are small — one new module exporting one readonly array and two pure predicates.

## New types & values

### `CLARIFICATION_QUESTION_MARKERS`

**Location**: `packages/orchestrator/src/worker/clarification-markers.ts`

**Type**: `readonly string[]` (asserted `as const` — a `readonly` tuple in TS terms).

**Contents** (order intentional — most-specific to least-specific for the debug log's `markerPrefix` field to be maximally informative):

```ts
export const CLARIFICATION_QUESTION_MARKERS: readonly string[] = [
  '<!-- generacy-stage:clarification',
  '<!-- generacy-clarifications:',
  '<!-- generacy-clarification:',
  '<!-- generacy-cockpit:clarifications-batch:',
] as const;
```

**Invariants**:

- Every element MUST begin with `<!-- generacy-` (the engine's HTML-comment namespace prefix). This is not asserted in code but serves as a code-review invariant.
- No element may be a strict prefix of another (avoids ambiguity in the `matchClarificationQuestionMarker` return value). Checked manually: `<!-- generacy-clarifications:` is not a prefix of `<!-- generacy-clarification:` (the trailing `s:` vs `:` differs at position 25); the four are pairwise-distinct at some position within the first 30 characters.
- Case-sensitive ASCII (Q1→B answer).

**Growth path**: adding a new dialect appends to this array. No other file changes are required — FR-108's "single place" contract. `commentCarriesQuestionMarker` and `matchClarificationQuestionMarker` iterate this array, and the tests iterate it to assert per-dialect exclusion.

### `commentCarriesQuestionMarker(body: string): boolean`

**Location**: `packages/orchestrator/src/worker/clarification-markers.ts` (exported)

**Signature**: `(body: string) => boolean`

**Contract**:

- Returns `true` iff `body` contains at least one line whose first character sequence (starting at column 0) is one of the prefixes in `CLARIFICATION_QUESTION_MARKERS`.
- `body` is treated as `\n`-delimited. `\r\n` — a possible input from GitHub REST — is tolerated: `\r` at end-of-line does not affect `startsWith` on the next line's opener.
- Empty string → `false`.
- Body with no `\n` and no marker → `false`.
- Body with marker at column 0 of any line (first, middle, last) → `true`.
- `> ` (block-quote) prefix at column 0 disqualifies the line (`startsWith` matches the marker at column 2, not 0).
- Leading whitespace (` `, `\t`) similarly disqualifies.

**Purity**: pure function, no side effects, no I/O, no time-dependence.

### `matchClarificationQuestionMarker(body: string): string | undefined`

**Location**: `packages/orchestrator/src/worker/clarification-markers.ts` (exported)

**Signature**: `(body: string) => string | undefined`

**Contract**:

- Same semantics as `commentCarriesQuestionMarker` for the match; returns the specific prefix string that matched (identity from `CLARIFICATION_QUESTION_MARKERS`) or `undefined` if no match.
- Returns the **first** match encountered when scanning lines in body order, and within a line the first match against the marker array in declaration order. Callers should treat "which marker" as informational (the FR-107 log line) — the invariant is that a matched prefix is stable and grep-friendly, not that it identifies the "most specific" prefix.
- Purity as above.

**Rationale for splitting from `commentCarriesQuestionMarker`**: the caller in `integrateClarificationAnswers` needs the prefix for the FR-107 log line's `markerPrefix` field. Rather than have `commentCarriesQuestionMarker` scan twice (once for boolean, once for prefix), we expose both entry points sharing the same internal loop.

## Existing types touched

### `TrustComment` (imported from `@generacy-ai/workflow-engine`)

Used unchanged. Fields consumed by the marker filter:

- `id: number` — for the FR-107 `commentId` field.
- `body: string` — the predicate input.
- `author: string` — for the FR-107 `author` field.
- `authorAssociation?: string` — **NOT** consulted by the marker filter (this is FR-103's whole point). Still present on the object for the downstream trust check.

### `Logger` (from `packages/orchestrator/src/worker/types.ts`)

Used unchanged. FR-107 calls `logger.debug(obj, msg)` — the pino-style call signature already used throughout `clarification-poster.ts`.

## Validation & error handling

- Predicate has no error path. Pure string operations on TypeScript-typed inputs.
- No Zod schema needed — the marker set is a compile-time-known internal constant, not a boundary input.
- No timeout / retry semantics — pure sync function.

## Relationships

```
                          CLARIFICATION_QUESTION_MARKERS
                                       │
                                       │ read by
                                       ▼
                        matchClarificationQuestionMarker
                                       │
                       ┌───────────────┴───────────────┐
                       ▼                               ▼
        commentCarriesQuestionMarker      integrateClarificationAnswers
                       │                              (FR-102 pre-filter,
                       │                               FR-107 debug log)
                       ▼
              isQuestionComment
              (FR-109 delegation
               — marker branch only;
               content-shape branches
               unchanged, FR-106)
```

Downstream (not part of this PR):

- `#910 clarify-resume surface` — planned consumer of `commentCarriesQuestionMarker` (FR-108, Q4→B answer). Imports directly from `clarification-markers.ts` when it lands.

## Non-changes to the data model

The following types remain untouched to keep the change footprint minimal:

- `STAGE_MARKERS` (`packages/orchestrator/src/worker/types.ts:90`) — separate marker family (stage-tracking, not clarifications). Spec Out-of-Scope §.
- `MARKER_PREFIX` (`packages/orchestrator/src/worker/clarification-poster.ts:163`) and `clarificationMarker(issueNumber)` — the orchestrator's posting-marker constant, used for dedup in `postClarifications`. The exclusion set is a **superset** of the posting-marker set (both include `<!-- generacy-clarifications:`); this is deliberate.
- `UNTRUSTED_ANSWER_MARKER_PREFIX` (line 81) / `untrustedAnswerMarker` — the explainer-comment dedup marker. Unrelated to FR-101.
- `ClarificationQuestion`, `ClarificationOption`, `ClarificationPostResult`, `IntegrationResult`, `ParsedAnswer` — no changes.
- `WorkerContext` — no changes.
- `TrustComment` / `CommentTrustContext` — no changes; imported from `@generacy-ai/workflow-engine` and consumed as-is.
