# Data Model: cockpit merge tier-1 resolver hardening (#913)

## New types

### `PullRequestGraphqlDetail` (exported from `@generacy-ai/cockpit`)

Return shape of the new `GhWrapper.getPullRequestGraphqlDetail(repo, prNumber)` method. Used by `runMergeWithExplicitPr` (FR-005..FR-008).

```ts
export interface PullRequestGraphqlDetail {
  /** GitHub PR state. Normalized from graphql `PullRequestState`. */
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  /** PR's head branch name. Load-bearing for the branch-deletion tail. */
  headRefName: string;
  /** True iff the PR is a draft. Distinct from FR-006b state gate. */
  isDraft: boolean;
  /**
   * GitHub `MergeStateStatus` — captured for future gates but not consumed by
   * the FR-005..FR-008 branches today. Values: CLEAN, DIRTY, UNSTABLE, BLOCKED,
   * BEHIND, HAS_HOOKS, UNKNOWN. Not gated on to keep --pr's precondition set
   * identical to runMerge's.
   */
  mergeStateStatus: string;
  /**
   * Every issue this PR declares as a closing target. Used by FR-006a to
   * verify linkage against the operator-supplied `<ref>`. Cross-repo linkage
   * is supported via `nameWithOwner` (rare but valid for multi-repo cockpit
   * runs — see WorkspaceConfig.repos multi-repo phases).
   */
  closingIssuesReferences: Array<{
    number: number;
    /** `owner/name` — for cross-repo comparison to `<ref>`. */
    nameWithOwner: string;
  }>;
}
```

**Invariants**:
- `closingIssuesReferences` may be empty. FR-006a refuses (exit 3) when empty.
- `state === 'MERGED'` may co-occur with `isDraft === false` (server rule; the merger flips the state field). FR-006b treats `MERGED` as the terminal idempotent-success state and does not re-examine `isDraft` in that branch.

### `RunMergeWithExplicitPrInput` (internal to `merge.ts`)

```ts
export interface RunMergeWithExplicitPrInput {
  gh: GhWrapper;
  /** The `<ref>` issue number — authorization source for `completed:validate`. */
  issue: number;
  repo: string;
  /** The operator-supplied `--pr <number>` value. Positive integer, validated. */
  prNumber: number;
  logger: Logger;
}
```

### `RunMergeResult` (widen exit-code union)

Existing type at `merge.ts:44`; widened from `0 | 1` to `0 | 1 | 2 | 3` to accommodate FR-008 refusal semantics.

```ts
export interface RunMergeResult {
  exitCode: 0 | 1 | 2 | 3;
  stdout: string;
}
```

- `0` — success (merge landed OR MERGED idempotent no-op).
- `1` — transport (parse-failure, graphql-after-retry failure, gh-CLI unexpected exit).
- `2` — argument-parse (`--pr` non-integer / non-positive, at Commander level via `parsePrFlag`).
- `3` — refusal at any gate (linkage / CLOSED-unmerged state / missing `completed:validate` / red checks).

## New zod schemas (internal to `wrapper.ts`)

### `Tier1InitialRefSchema` (FR-004 — 2.96.0 minimal shape tolerance)

```ts
const Tier1InitialRefSchema = z
  .object({
    number: z.number().int().optional(),
    url: z.string().optional(),
  })
  .passthrough();
```

- `number` is optional to tolerate hypothetical future minimal shapes; the parser recovers from `url` via `extractPrNumberFromUrl` when `number` is absent (sibling pattern at `wrapper.ts:478–520`).
- `.passthrough()` — additional fields present in gh 2.95.x (`state`, `headRefName`, etc.) are silently accepted.

### `Tier1InitialResponseSchema`

```ts
const Tier1InitialResponseSchema = z
  .object({
    closedByPullRequestsReferences: z.array(Tier1InitialRefSchema).default([]),
  })
  .passthrough();
```

- `.default([])` — issues with no closing PRs return an empty array; tier-1 returns `[]` and the resolver falls through to tier-2 as it always has.

### `Tier1FollowupRefSchema` (FR-002 — graphql per-PR node)

```ts
const Tier1FollowupRefSchema = z.object({
  number: z.number().int(),
  state: z.string(),                 // normalized downstream by normalizePullRequestState
  headRefName: z.string(),
  isDraft: z.boolean(),
  url: z.string(),
});
```

- Not `.passthrough()` — the query selects exactly these fields; extra fields would indicate a graphql server-side change worth flagging.

### `Tier1FollowupResponseSchema`

Shaped to match the aliased-fields graphql response. Each requested PR becomes a per-number alias (`pr0`, `pr1`, …) whose value is `Tier1FollowupRefSchema | null` (null = PR not found / deleted).

```ts
const Tier1FollowupResponseSchema = z.object({
  data: z.object({
    repository: z.object({
      // Keys are `pr0`, `pr1`, ... — parsed via record after aliasing.
    }).catchall(Tier1FollowupRefSchema.nullable()),
  }),
});
```

- `.catchall(...)` — pattern-matches every alias key. Non-alias keys (server error extensions, etc.) are still validated by the `catchall` predicate; the schema's discriminant is the `data.repository` shape, not the alias namespace.

### `PrGraphqlDetailSchema` (FR-006)

```ts
const PrGraphqlDetailSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        state: z.string(),
        headRefName: z.string(),
        isDraft: z.boolean(),
        mergeStateStatus: z.string(),
        closingIssuesReferences: z.object({
          nodes: z.array(
            z.object({
              number: z.number().int(),
              repository: z.object({ nameWithOwner: z.string() }),
            }),
          ),
        }),
      }).nullable(),
    }),
  }),
});
```

- `pullRequest.nullable()` — server returns `null` when the PR doesn't exist in the target repo. Runtime handling: throw `Error(`PR #<n> not found in <repo>`)`, exit 1 (transport-class).

## Validation rules

### FR-006a linkage check (in `runMergeWithExplicitPr`)

```
declares = pr.closingIssuesReferences.some(
  (l) => l.nameWithOwner === repo && l.number === issue
);
if (!declares) {
  refuse(kind = closingIssuesReferences.length === 0 ? 'empty-refs' : 'mismatch');
}
```

- **Exact match** on `nameWithOwner` (case-sensitive; both sides come from GitHub-canonical sources).
- **Exact match** on `number` (integer equality).
- **Refusal kinds**: `empty-refs` (PR declares no closing issues) and `mismatch` (PR declares some, but not `<ref>`). Both surface as exit 3 with distinct log payloads and stdout `reason` values.

### FR-006b state classifier (in `runMergeWithExplicitPr`)

```
switch (pr.state) {
  case 'OPEN':   continue;                                    // → gates 3 & 4
  case 'MERGED': return { exitCode: 0, stdout: idempotent }; // idempotent no-op
  case 'CLOSED': return { exitCode: 3, stdout: refused };    // refusal
}
```

**Ordering (FR-008)**: linkage → state → `completed:validate` → check-classification. First failing gate emits the refusal; subsequent gates are not evaluated. Refusal message names the gate that tripped.

### `parsePrFlag(input: string): number` (Commander parser)

- Input is Commander's raw string.
- Trim leading/trailing whitespace.
- Reject empty string, non-numeric, negative, zero, non-integer decimals.
- Reject values > `Number.MAX_SAFE_INTEGER` (guardrail, not user-facing).
- Success: return the parsed positive integer.
- Failure: throw `CockpitExit(2, "merge: --pr must be a positive integer, got: <input>")`.

## Relationships

```
                                         [gh CLI]
                                            │
                                            ▼
              ┌───────────────────────────────────────────────────┐
              │                    GhCliWrapper                    │
              │  (packages/cockpit/src/gh/wrapper.ts)              │
              └───────────────────────────────────────────────────┘
                    │                    │                    │
    resolveIssueToPRRef       getPullRequestGraphqlDetail    (unchanged)
              │                          │
              │ (calls twice)            │
              ▼                          ▼
  queryTier1ClosingRefs        `gh api graphql -F …`
    (1) `gh issue view --json …`     with PR_DETAIL_QUERY
    (2) `gh api graphql -F …`
          with TIER1_FOLLOWUP_QUERY
              │                          │
              ▼                          ▼
      PullRequestRef[]        PullRequestGraphqlDetail
              │                          │
              ▼                          ▼
   [resolver-driven runMerge]   runMergeWithExplicitPr
              │                          │
              └───────────┬──────────────┘
                          ▼
             assertCompletedValidateAndMerge
              (shared tail: fetchIssueState,
               classifyChecks, mergePullRequest,
               classifyAndDeleteBranch)
                          │
                          ▼
                    [merged PR]
```

## Field-level trace: FR-006a linkage check

```
CLI:  cockpit merge x/y#123 --pr 456
      └── issueRef = { owner: 'x', repo: 'y', number: 123 }
      └── prNumber = 456
      └── repo = 'x/y'

GraphQL response (illustrative):
  { data: { repository: { pullRequest: {
      state: 'OPEN',
      headRefName: 'feature/foo',
      isDraft: false,
      mergeStateStatus: 'CLEAN',
      closingIssuesReferences: {
        nodes: [
          { number: 123, repository: { nameWithOwner: 'x/y' } },   // ✓ match
          { number: 789, repository: { nameWithOwner: 'x/z' } },   // ✗
        ],
      },
  } } } }

Predicate:
  declares = nodes.some(l => l.nameWithOwner === 'x/y' && l.number === 123)
           = true
  → gate passes, proceed to FR-006b state classifier.
```

**Cross-repo case** (rare but valid, from `WorkspaceConfig.repos` multi-repo phases):

```
CLI:  cockpit merge repo-a/api#42 --pr 99 --repo repo-a/frontend
      └── issueRef = { owner: 'repo-a', repo: 'api', number: 42 }
      └── prNumber = 99
      └── repo (PR's) = 'repo-a/frontend'

GraphQL response nodes:
  [ { number: 42, repository: { nameWithOwner: 'repo-a/api' } } ]  ✓

Predicate:
  declares = nodes.some(l => l.nameWithOwner === 'repo-a/api' && l.number === 42)
           = true
```

The `--repo` flag names the PR's repo (per merge's existing semantics); `<ref>` uses its own `owner/repo#N` form (or bare-number-inferred). FR-006a compares `<ref>`'s `nameWithOwner` against each linkage node's `nameWithOwner`.

## Exit code semantics summary

| Scenario                                      | Exit | Path                                       |
|-----------------------------------------------|------|--------------------------------------------|
| Successful merge (resolver-driven)            | 0    | `runMerge` — unchanged                     |
| Successful merge (`--pr`)                     | 0    | `runMergeWithExplicitPr` → shared tail     |
| MERGED PR, linkage OK (`--pr`)                | 0    | FR-006b idempotent branch                  |
| Argument parse error (`--pr` bad value)       | 2    | `parsePrFlag` → `CockpitExit(2)`           |
| Linkage refused (`--pr`, empty or mismatch)   | 3    | FR-006a gate                                |
| CLOSED-unmerged (`--pr`)                      | 3    | FR-006b refusal branch                     |
| Missing `completed:validate` (either path)    | 1 → 3† | Shared tail — see note                   |
| Checks failing (either path)                  | 1 → 3† | Shared tail — see note                   |
| Tier-1 graphql failure after retry (resolver) | 1    | `queryTier1FollowupGraphql` throw          |
| Any parse failure with `gh version:` info     | 1    | `formatShapeMismatchError` throw           |

† **Note on exit-3 vs. exit-1 for shared-tail refusals**: today's `runMerge` returns exit 1 for missing-label and red-checks (see `merge.ts:224` and `merge.ts:275`). The `--pr` path's FR-008 says these are exit-3 refusals. Two options considered in Decision 3 of `research.md`:
1. **Widen `runMerge` to also return 3** for these gates — behavioral change to the sanctioned path.
2. **Have the shared `assertCompletedValidateAndMerge` accept an `exitCode` policy parameter** — the resolver-driven path passes `1` (parity with today); the `--pr` path passes `3` (per FR-008).

The plan adopts option 2 (`exitPolicy: 'resolver' | 'pr-flag'`) to avoid a behavioral regression on the resolver-driven path. Documented in `contracts/pr-flag-cli.md` §5.
