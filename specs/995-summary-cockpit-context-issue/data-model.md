# Data Model: fix `cockpit_context` clarification-comment finder against label re-application

## Scope

This is a bugfix; no new persistent entities, no new API schemas, no new wire types. Data-model consists of:

1. The **existing types** the finder reads and returns (unchanged).
2. The **derived intermediate value** the fix introduces internally (a filtered/sorted `IssueComment[]` slice; not a public type).

## Public types (unchanged)

### `IssueComment` (from `@generacy-ai/cockpit`)

Shape used by the finder:

```ts
interface IssueComment {
  body: string;        // marker inspection target
  author: string;      // not consulted by finder
  createdAt: string;   // ISO-8601, used for tiebreak
  url: string;         // returned to caller for context assembly
  // …other fields untouched
}
```

### `GhWrapper` (from `@generacy-ai/cockpit`)

Two methods consumed:

```ts
fetchIssueTimeline(repo: string, number: number): Promise<TimelineEvent[]>
fetchIssueComments(repo: string, number: number): Promise<IssueComment[]>
```

Both signatures unchanged. Finder still calls both — `fetchIssueTimeline` only when pass 1 misses (i.e., the fallback branch is entered). One optimization worth noting: skip the timeline fetch entirely when pass 1 succeeds, saving one API call per re-applied-label case (the common path post-fix).

### `TimelineLabelEvent` (module-local, unchanged)

```ts
interface TimelineLabelEvent {
  event?: string;
  created_at?: string;
  label?: { name?: string };
}
```

## Function signature (unchanged)

```ts
export async function findClarificationComment(
  gh: GhWrapper,
  repo: string,
  number: number,
): Promise<IssueComment | null>
```

FR-008 + spec Out-of-Scope forbid signature change. Any test that wants to inject a logger must do so via `vi.spyOn` on the module-level `getLogger()` (D3 in plan.md).

## Derived types (module-local, no export)

### Filter + sort pipeline

```ts
const markerHits: IssueComment[] = comments
  .filter((c) => matchClarificationQuestionMarker(c.body) !== undefined)
  .filter((c) => !isStageStatusComment(c.body))
  .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
```

- `matchClarificationQuestionMarker` returns `string | undefined`; `!== undefined` collapses to a boolean.
- Sort is descending by `createdAt`; `markerHits[0]` is the target return.
- Both filters are applied to the full comment set (no early exit) — the sort is O(n log n) but n is small (comment count per issue). Not perf-critical.

## Validation rules

### R-V1 — marker match is line-anchored at column 0

Enforced by `matchClarificationQuestionMarker` (delegates line splitting). Any comment where the marker appears only in the middle of a line, or is `> `-quoted, does NOT match. Preserves the existing invariant used throughout the clarification plumbing.

### R-V2 — stage-status exclusion applies to both passes

`isStageStatusComment` is applied *after* the marker filter and *inside* the timeline fallback (identical to today's behavior). Symmetric.

### R-V3 — fallback logs exactly once per finder invocation

The warn log is emitted at the fallback branch entry, not inside any inner loop. Bounded log volume.

### R-V4 — return type stays `IssueComment | null`

- Marker match found → return `markerHits[0]`.
- No marker; timeline fallback finds a comment → return that comment.
- No marker; timeline fallback returns nothing (no `waiting-for:clarification` label, or no post-label comment, or only stage-status comments post-label) → return `null`.

## Relationships

None new. The finder's only external dependency is the `@generacy-ai/orchestrator` marker registry, which was already an indirect coupling (via the poster stamping the markers this finder now reads).

## Data-migration considerations

None. No persistent store touched. Legacy issues with no marker-carrying comments continue to work via the fallback branch. Issues with the label re-applied post-question-comment start working immediately without any backfill.
