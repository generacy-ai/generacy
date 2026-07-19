# Data Model: Clarification-answer monitor predicate rewrite

**Feature**: `993-summary-orchestrator-s`
**Date**: 2026-07-18

This feature changes zero persistent data. It changes one in-memory predicate on already-fetched `Comment` objects, and one exported string-matching predicate. This document names the affected types, the invariants they must preserve, and the new file-local helpers that carry the new logic.

## `Comment` (existing — no schema change)

**Location**: `packages/workflow-engine/src/types/github.ts:72-104`

```ts
export interface Comment {
  id: number;
  body: string;
  author: string;             // GitHub login, possibly [bot]-suffixed (REST) or bare (GraphQL)
  created_at: string;         // RFC 3339 Z-terminated ISO-8601 (e.g. "2026-07-18T10:23:45Z")
  updated_at: string;
  path?: string;
  line?: number;
  in_reply_to_id?: number;
  resolved?: boolean;         // @deprecated
  authorAssociation?: string; // OWNER | MEMBER | COLLABORATOR | ... | undefined
  viewerDidAuthor?: boolean;  // GraphQL-populated on getIssueCommentsWithViewerAuth; undefined elsewhere
}
```

**Fields consumed by #993's predicate** (all already populated by the GraphQL fetch path at `gh-cli.ts:318-392`):

- `author` — the FR-001 `[bot]`-suffix check.
- `created_at` — the FR-004 newness check.
- `body` — the marker checks (FR-005 machine-marker skip; FR-003(a) answer-marker positive; FR-004 anchor lookup via `matchClarificationQuestionMarker`).
- `authorAssociation` and `viewerDidAuthor` — passed unchanged into `isTrustedCommentAuthor` for the FR-003(b) trusted-human branch.

**Invariants preserved**:

- The wire format for `author` on REST is `<login>[bot]`; on GraphQL it's `<login>`. `normalizeLogin` strips `[bot]` and lowercases, but the FR-001 filter runs on the *raw* `comment.author` string, precisely because the `[bot]` suffix is the detection signal we care about. Callers must not pre-normalize the author before invoking the FR-001 filter.
- `created_at` is compared lexicographically. GitHub guarantees RFC 3339 Z-terminated timestamps at second precision on both REST and GraphQL surfaces; string compare and time compare are equivalent. If a future GitHub API change relaxes this (e.g. offset-suffixed timestamps like `2026-07-18T06:23:45-04:00`), the string compare would silently mis-order — the fix is `new Date(a).getTime() > new Date(b).getTime()`. Not needed today.

## `CLARIFICATION_QUESTION_MARKERS` (existing — no schema change)

**Location**: `packages/orchestrator/src/worker/clarification-markers.ts:18-23`

Unchanged registry:

```ts
export const CLARIFICATION_QUESTION_MARKERS: readonly string[] = [
  '<!-- generacy-stage:clarification',
  '<!-- generacy-clarifications:',
  '<!-- generacy-clarification:',
  '<!-- generacy-cockpit:clarifications-batch:',
] as const;
```

Used unchanged by the FR-004 anchor lookup via `matchClarificationQuestionMarker`.

## `CLARIFICATION_ANSWER_MARKERS` (existing — no schema change)

**Location**: `packages/orchestrator/src/worker/clarification-markers.ts:62-64`

```ts
export const CLARIFICATION_ANSWER_MARKERS: readonly string[] = [
  '<!-- generacy-clarification-answers:',
] as const;
```

Referenced by FR-003(a): a comment carrying an answer marker qualifies as an answer only when the author is not `[bot]`-suffixed. The registry itself is unchanged.

## `MACHINE_MARKERS` (existing — semantic change to matcher)

**Location**: `packages/orchestrator/src/worker/clarification-markers.ts:110-131`

**Current shape**:

```ts
export const MACHINE_MARKERS: readonly string[] = [
  ...CLARIFICATION_QUESTION_MARKERS,           // (kept)
  '<!-- generacy-stage:specification',          // (subsumed by family match — remove)
  '<!-- generacy-stage:planning',               // (subsumed — remove)
  '<!-- generacy-stage:implementation',         // (subsumed — remove)
  '<!-- speckit-stage:specification',           // (subsumed — remove)
  '<!-- speckit-stage:planning',                // (subsumed — remove)
  '<!-- speckit-stage:implementation',          // (subsumed — remove)
  '<!-- generacy-cockpit:manual-advance',       // (kept — not stage-family)
  '<!-- generacy-clarification-answers:',       // (kept — answer-relay)
  '<!-- generacy-untrusted-answer:',            // (kept — explainer)
  '<!-- generacy-clarification-parse-failures:',// (kept — diagnostic)
] as const;
```

**Post-#993 shape** (the exported array holds only the non-stage families; the two stage families move into a new sibling constant):

```ts
export const MACHINE_MARKER_FAMILIES: readonly string[] = [
  '<!-- generacy-stage:',
  '<!-- speckit-stage:',
] as const;

export const MACHINE_MARKERS: readonly string[] = [
  ...CLARIFICATION_QUESTION_MARKERS,
  '<!-- generacy-cockpit:manual-advance',
  '<!-- generacy-clarification-answers:',
  '<!-- generacy-untrusted-answer:',
  '<!-- generacy-clarification-parse-failures:',
] as const;
```

**Matcher change** (`matchMachineMarker`): try `MACHINE_MARKER_FAMILIES` first (fast prefix loop), then fall back to the enumerated `MACHINE_MARKERS`. Same line-anchored, case-sensitive prefix-substring semantics as before. `commentCarriesMachineMarker` continues to be `matchMachineMarker(body) !== undefined` — unchanged in signature.

**Invariants preserved**:

- Line-anchored: matches only when the prefix starts at column 0 of some line. `> `-quoted markers still do NOT match.
- Case-sensitive ASCII.
- Return type: `matchMachineMarker` still returns `string | undefined`. When a family match fires, the returned string is the *family prefix* (`'<!-- generacy-stage:'` or `'<!-- speckit-stage:'`), not the full-suffix marker. Callers who use the return value for logging see a slightly less specific string; verified: no caller today parses or switches on the returned string.

**Callers**:

- `clarification-answer-monitor-service.ts:206` — uses `commentCarriesMachineMarker(c.body)` as a `continue` guard.
- `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` — uses `commentCarriesMachineMarker` in the phase-loop answer scanner.
- No caller iterates `MACHINE_MARKERS` directly (verified via `grep -r MACHINE_MARKERS packages/`), so removing enumerated entries has no read-path side effect.

## New file-local helpers (in `clarification-answer-monitor-service.ts`)

These are private `function` declarations, not exported, colocated with the class in the same file. They are pure — no I/O, no state.

### `isBotAuthoredLogin`

```ts
/**
 * Returns true iff `author` looks like a GitHub App / bot login.
 * Case-insensitive, whitespace-tolerant. Matches REST's `<login>[bot]`
 * surface form. GraphQL returns `<login>` sans suffix — those never match
 * here, which is fine because the App identity on this cluster is only
 * observable through comment authorship on REST-shaped payloads (viewer-
 * auth GraphQL retains the `[bot]` suffix on `author.login`).
 *
 * Reason for co-location: see plan.md §"No premature abstraction".
 */
function isBotAuthoredLogin(author: string): boolean {
  return author.trim().toLowerCase().endsWith('[bot]');
}
```

**Invariants**:

- Empty / whitespace-only `author` → `false`.
- Normalized comparison — case-insensitive, whitespace-tolerant. Matches `normalizeLogin`'s normalization shape (comment-trust.ts:49-51) but *detects* the suffix instead of *removing* it.
- Pure function — same input, same output. No time, env, or process reads.

### `latestQuestionCommentCreatedAt`

```ts
/**
 * Returns the newest `created_at` (ISO-8601 lexicographic) among comments
 * whose body matches any prefix in `CLARIFICATION_QUESTION_MARKERS`.
 * Returns `undefined` when there is no question-marker comment on the
 * issue (nothing to answer → the FR-004 predicate short-circuits false).
 *
 * ISO-8601 Z-terminated string compare == time compare. See research.md §Q4.
 */
function latestQuestionCommentCreatedAt(comments: Comment[]): string | undefined {
  let latest: string | undefined;
  for (const c of comments) {
    if (matchClarificationQuestionMarker(c.body) === undefined) continue;
    if (latest === undefined || c.created_at > latest) {
      latest = c.created_at;
    }
  }
  return latest;
}
```

**Invariants**:

- Empty input → `undefined`.
- No mutation of input.
- Deterministic — for a fixed input, returns the same output.
- If two comments carry a question marker AND share the same `created_at`, either could be "latest" per the definition; the predicate uses `>` (strict) below, so a candidate answer must beat that shared timestamp. Ties on question timestamps do not create ambiguity.

## Predicate composition (new — inside `processClarificationAnswerEvent`)

The `hasHumanTrustedComment` loop currently at `clarification-answer-monitor-service.ts:204-212` is replaced with the following composition. Structure only; contracts are in `contracts/monitor-predicate-contract.md`:

```
questionAnchor = latestQuestionCommentCreatedAt(comments)
if (questionAnchor === undefined) return false      // FR-004 short-circuit — nothing to answer

candidate = null
for c of comments:
  if (commentCarriesMachineMarker(c.body)) continue   // FR-005 machine-marker skip
  if (isBotAuthoredLogin(c.author)) continue           // FR-001 bot filter (upstream of trust)
  if (c.created_at <= questionAnchor) continue         // FR-004 strict newness

  // Two positive branches (FR-003):
  if (commentCarriesAnswerMarker(c.body)) {            // (a) marker + non-bot
    candidate = c; break
  }
  const decision = isTrustedCommentAuthor(c, 'answer-scanner', trustCtx)
  if (decision.trusted && decision.reason !== 'bot' && decision.reason !== 'self-authored') {
    // (b) non-bot, non-cluster-self, trusted by association tier
    candidate = c; break
  }

if (!candidate) return false
// … continue with the existing enqueueIfAbsent path …
```

**Invariant on the trust decision filter**: we exclude `reason: 'bot'` and `reason: 'self-authored'` from the accepted trust reasons because the FR-001 upstream filter already rejects all `[bot]` authors — a `reason: 'bot'` slipping through would indicate an inconsistency (e.g. a non-`[bot]`-suffixed author matching `ctx.botLogin` — the resolved account, `christrudelpw`), which is the same-account case that also should not resume this monitor (`viewerDidAuthor === true` short-circuit). Being explicit here makes the policy self-documenting.

## Related types (no schema change, referenced for completeness)

- `ClarificationAnswerEvent` — `packages/orchestrator/src/services/clarification-answer-monitor-service.ts:50-56` (unchanged)
- `CommentTrustContext` — `packages/workflow-engine/src/security/comment-trust.ts:36-40` (unchanged)
- `TrustDecision`, `TrustReason` — `packages/workflow-engine/src/security/comment-trust.ts:15-34` (unchanged; the monitor now filters on `reason`, but `reason` is already a stable public enum)
- `QueueItem`, `QueueManager` — `packages/orchestrator/src/types/monitor.ts` (unchanged)
- `MonitorState` — `packages/orchestrator/src/types/monitor.ts` (unchanged; `#987` extends it, `#993` does not)

## No persistent data changes

- No database schema changes.
- No new files under `.agency/` or `/var/lib/generacy/`.
- No new environment variables.
- No config schema changes.
- No changeset entries required beyond the top-level `.changeset/993-clarification-answer-bot-filter.md` (`patch` for `@generacy-ai/orchestrator`).
