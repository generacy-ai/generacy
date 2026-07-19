# Contract: `findClarificationComment` (post-fix)

## Signature (unchanged from today)

```ts
export async function findClarificationComment(
  gh: GhWrapper,
  repo: string,       // "owner/repo"
  number: number,     // issue number
): Promise<IssueComment | null>;
```

Public re-exports and callers unaffected. Only call site: `packages/generacy/src/cli/commands/cockpit/context.ts:228`.

## Preconditions

- `gh` is a working `GhWrapper` (already the caller's responsibility).
- `repo` is `owner/repo` form.
- `number` is a positive integer issue number.

## Postconditions

Exactly one of the following holds on successful return:

| # | Return value | Preconditions on input state |
|---|--------------|------------------------------|
| 1 | Marker-carrying `IssueComment` (latest-by-`createdAt`) | ≥1 issue comment carries a `CLARIFICATION_QUESTION_MARKERS` prefix at column 0 AND is not a stage-status comment. |
| 2 | Non-marker `IssueComment` from fallback timeline heuristic | 0 marker-carrying non-stage-status comments AND ≥1 `waiting-for:clarification` `labeled` event AND ≥1 non-stage-status comment with `createdAt ≥ latestLabelTs`. |
| 3 | `null` | 0 marker-carrying non-stage-status comments AND (0 label events OR 0 post-label non-stage-status comments). |

Return value #1 corresponds to FR-001 / FR-002.
Return value #2 corresponds to FR-005 (fallback branch — a warn log is emitted before this return).
Return value #3 corresponds to the terminal-failure branch (a warn log is also emitted, since the fallback ran).

## Ordering guarantees

- Marker branch (return #1): **latest by `createdAt`** (descending sort). Ties broken by whichever order `Array.prototype.sort` produces (browser/Node stable-sort semantics — v8's sort is stable since Node 12).
- Fallback branch (return #2): **first by `createdAt` at-or-after `latestLabelTs`** (ascending sort), identical to today's behavior.

## Error surface

The finder does not catch or transform exceptions from `gh.fetchIssueTimeline` or `gh.fetchIssueComments`; they propagate to the caller. `context.ts` handles them at line 228 today; no change.

## Logging contract (new)

Exactly ONE `warn` log line is emitted per invocation on branches #2 and #3 (fallback ran). ZERO log lines on branch #1 (marker hit).

**Format**:
```
level: 'warn'
message: 'marker-less clarification comment; poster should be updated — issue=<owner/repo#N>'
fields: { owner: string, repo: string, issue: number }
```

Where `<owner/repo#N>` uses the input `repo` (already `owner/repo` form) and `number`.

**Rationale**: measurable deprecation signal per Q2 answer.

## Marker match rule (delegated, not defined here)

Column-0 line-anchored, case-sensitive ASCII prefix match against `CLARIFICATION_QUESTION_MARKERS`. Implementation lives in `matchClarificationQuestionMarker` (`@generacy-ai/orchestrator`). This contract does NOT allow the finder to define its own match rule (FR-006).

## Stage-status exclusion (unchanged)

A comment is a "stage-status comment" iff `isStageStatusComment(body) === true`. This helper (`clarification-comment-finder.ts:29-42`) is the source of truth and MUST be applied to candidates in BOTH branches. Its override rule (`CLARIFICATION_STAGE_OVERRIDE_PREFIXES`) ensures a legitimate `<!-- generacy-stage:clarification*` comment is not rejected even though it also matches a reject-prefix substring.

## API-call budget

Under the marker-hit branch (return #1): 1 call (`fetchIssueComments`). Timeline fetch is deferred to the fallback branch only.

Under the fallback branch (returns #2, #3): 2 calls (`fetchIssueComments` + `fetchIssueTimeline`).

This is an *improvement* on today's behavior (2 calls unconditionally). No caller depends on the timeline being fetched; this is a safe deferral.

## Backwards compatibility

- Existing callers see the same signature and same return type.
- Existing behavior preserved on every input where the fallback branch is taken (returns #2 and #3 today).
- New positive behavior on inputs where marker-carrying comments exist but label re-application would previously have masked them (was `null` before, is now the marker comment).
- No caller currently distinguishes "first comment after label" vs "latest marker comment" — spec Assumption 3 states downstream consumers only want "the current open-question comment", which the fix delivers more accurately.
