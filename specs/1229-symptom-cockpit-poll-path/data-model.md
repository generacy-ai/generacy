# Data Model: Scope cockpit poll events to the epic's resolved ref set

No new persisted state. All types are in-memory; existing types are listed where their
contract matters to the fix.

## Modified interface: `GhWrapper` (`packages/cockpit/src/gh/wrapper.ts`)

```ts
export interface GhWrapper {
  // …existing methods unchanged…

  /**
   * Batched exact lookup of issue/PR refs by number via aliased GraphQL
   * `issueOrPullRequest(number:)`. Returns both issues and PRs mapped into the
   * `Issue` shape. Nonexistent numbers are silently absent (NOT_FOUND
   * tolerated); any other GraphQL/transport error throws. Empty `numbers`
   * resolves [] without a subprocess call. Chunks at ≤100 numbers per call.
   */
  batchLookupIssuesOrPrs(repo: string, numbers: number[]): Promise<Issue[]>;
}
```

### Result mapping (GraphQL → existing `Issue`)

| `Issue` field | GraphQL `Issue` source | GraphQL `PullRequest` source |
|---|---|---|
| `number` | `number` | `number` |
| `title` | `title` | `title` |
| `state` | `state` (`OPEN`/`CLOSED`) | `state`, with `MERGED → 'CLOSED'` |
| `stateReason` | `stateReason` (`COMPLETED`/`NOT_PLANNED`/null) | `null` (PRs have none) |
| `labels` | `labels(first:100).nodes[].name` | same |
| `url` | `url` (`…/issues/N`) | `url` (`…/pull/N` — drives `isPullRequest`) |
| `body` | `body` | `body` |
| `author` | `author.login` (nullable → omitted) | same |
| `createdAt` | `createdAt` | `createdAt` |

Zod response envelope (new, alongside `Tier1FollowupResponseSchema`):

```ts
const BatchLookupNodeSchema = z.discriminatedUnion('__typename', [
  z.object({ __typename: z.literal('Issue'), /* fields above */ }),
  z.object({ __typename: z.literal('PullRequest'), /* fields above */ }),
]).nullable();

const BatchLookupResponseSchema = z.object({
  data: z.object({ repository: z.record(BatchLookupNodeSchema) }),
  errors: z.array(z.object({ type: z.string().optional() }).passthrough()).optional(),
});
```

Validation rules:
- `repository` values iterate like `tier1FollowupOnce` — `null` aliases skipped.
- `errors` present and every entry `type === 'NOT_FOUND'` → partial data accepted.
- `errors` with any other/absent type → throw.

## Modified interface: `PollDeps` (`watch/poll-loop.ts`)

```ts
export interface PollDeps {
  gh: GhWrapper;
  /** Refs resolved from the epic body for this tick — authoritative scope. */
  refs: IssueRef[];
  logger?: { warn: (msg: string) => void; debug?: (msg: string) => void };
  now?: () => string;
  cycleNumber?: number;
}
```

Removed: `epicOwnerRepo` (only fed the zero-refs sentinel query), `safetyCap`, `pageSize`
(pagination gone; result size bounded by `refs`). Callers updated: `watch.ts`,
`mcp/event-bus-registry.ts`, `doorbell/aggregate-on-demand.ts`, tests.

## New helper: `filterToRefSet` (`shared/ref-set-filter.ts`, `packages/generacy`)

```ts
export function filterToRefSet(
  issues: Issue[],
  repo: string,
  refs: IssueRef[],
  logger?: { debug?: (msg: string) => void },
): Issue[];
```

- Membership key: `` `${repo.toLowerCase()}#${issue.number}` `` vs
  `` `${ref.repo.toLowerCase()}#${ref.number}` `` — mirrors `snapshotKey`'s #1106
  lowercase-repo normalization.
- Pure; drops log one `debug` line each; no API calls.
- Consumers: `runOnePoll` (defence-in-depth behind exact lookup), `runStatus`
  (`status.ts`, filters `listAllIssues` search results).

## Unchanged contracts (relied upon)

- `IssueRef` (`@generacy-ai/cockpit`): `{ repo: string /* owner/name */, number: number }` —
  `deps.refs` / `parsed.allRefs` is the authoritative scope set (spec assumption).
- `Snapshot` / `SnapshotMap` / `snapshotKey` (`watch/snapshot.ts`): key format
  `<repo-lower>#<issue|pr>#<number>` unchanged.
- `CockpitEvent` (`watch/diff.ts`): shape and ordering (label-change → lifecycle →
  pr-checks) unchanged; `computeTransitions` untouched.
- `derivePrLifecycle` / `derivePrChecksNeeded` (`watch/pr-state.ts`): unchanged — now
  actually reachable on the poll path.
- Aggregate accounting (`watch/aggregate.ts`): keys off `parsed.allRefs`, not `curr`;
  untouched.

## Relationships

```
resolveEpic ──▶ parsed.allRefs (scope authority)
                    │
                    ▼
runOnePoll ──▶ gh.batchLookupIssuesOrPrs(repo, numbers)   [exact — cannot free-text match]
                    │
                    ▼
              filterToRefSet(issues, repo, refs)           [defensive post-filter]
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
  issue snapshot          PR branch (lifecycle, gated checks)   [revived]
        └───────────┬───────────┘
                    ▼
            computeTransitions ──▶ epic event bus ──▶ cockpit_await_events / watch NDJSON
```
