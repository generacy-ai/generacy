# Contract: GraphQL selection sets for tier-1 follow-up and `--pr` PR-detail

## §1 — Why explicit GraphQL, not `gh pr view --json`

Per clarify Q5→B and research §1 (`research.md`), the fix must NOT re-anchor on the `--json` serializer that started this fire. Two GraphQL calls replace / augment the prior `--json`-only flow:

1. **Tier-1 follow-up** (FR-002 / FR-002a) — supplies per-PR `state`, `headRefName`, `isDraft` to the resolver in a single call.
2. **`--pr` PR detail** (FR-006) — supplies `{ state, headRefName, isDraft, mergeStateStatus, closingIssuesReferences }` to the escape-hatch branch.

Both queries are invoked as `gh api graphql -F owner=<owner> -F repo=<repo> [-F number=<n> | -F numbers=<n1,n2,…>] -f query=<TEMPLATE>`.

## §2 — `TIER1_FOLLOWUP_QUERY(numbers: number[])`

### Selection set (aliased-fields form)

Given the initial `gh issue view --json closedByPullRequestsReferences` returned PR numbers `[N0, N1, …, NK]` (K ≤ ~10 in practice; ~20 as a defensive upper bound before we chunk), the follow-up query is:

```graphql
query CockpitTier1Followup($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    pr0: pullRequest(number: N0) { number state headRefName isDraft url }
    pr1: pullRequest(number: N1) { number state headRefName isDraft url }
    # ... one aliased selection per input number
    prK: pullRequest(number: NK) { number state headRefName isDraft url }
  }
}
```

- **Alias convention**: `pr<i>` where `<i>` is the zero-based input index (not the PR number itself — aliases must be legal graphql identifiers, and prefixing with `pr` keeps them lexical).
- **Query construction**: dynamic — `buildTier1FollowupQuery(numbers: number[]): string` template-literal-builds the query at call time. This is safe because `numbers` came from a zod-validated integer parse of gh's own output; injection surface is zero.
- **Response shape**: `{ data: { repository: { pr0: {...}, pr1: {...}, …, prK: {...} | null } } }`. `null` value = PR not found (deleted / permissions).

### Chunking

If `numbers.length > TIER1_FOLLOWUP_CHUNK_LIMIT` (default 20), the caller chunks and issues N/20 calls. Not expected to fire in practice; documented for defense.

### Failure semantics

Per FR-002a and clarify Q4→D:

| Attempt | Outcome  | Next step                                                          |
|---------|----------|---------------------------------------------------------------------|
| 1st     | success  | Return `Map<number, PullRequestRef>` and proceed to FR-003 filter. |
| 1st     | failure  | `sleep(1000ms)` then retry.                                        |
| 2nd     | success  | Same as 1st-attempt success.                                       |
| 2nd     | failure  | Throw. Caller (`resolveIssueToPRRef`) bubbles → exit 1. **Never** fall through to tier-2; **never** filter to survivors. |

"Failure" includes: `gh api graphql` non-zero exit, JSON.parse error, zod shape mismatch, `data.repository == null` (repo not found or access denied). Missing per-PR aliases (`data.repository.pr3 === null`) are NOT failures — the tier-1 filter accepts a smaller-than-requested result and continues (a null PR is one that closed the issue but is no longer accessible; the resolver correctly filters it away as if it never existed).

## §3 — `PR_DETAIL_QUERY(number: number)`

### Selection set

```graphql
query CockpitPrDetail($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state
      headRefName
      isDraft
      mergeStateStatus
      closingIssuesReferences(first: 20) {
        nodes {
          number
          repository { nameWithOwner }
        }
      }
    }
  }
}
```

### Field-by-field justification

| Field                          | Why we need it                                          | FR reference   |
|--------------------------------|---------------------------------------------------------|----------------|
| `state`                        | FR-006b state classifier (`OPEN`/`MERGED`/`CLOSED`)     | FR-006, FR-006b |
| `headRefName`                  | branch deletion in the shared merge tail                | FR-007 (shared)|
| `isDraft`                      | consistency / potential future gates; captured for parity with resolver-driven path | FR-006  |
| `mergeStateStatus`             | captured for future gates but not currently gated on    | Decision 6 in `research.md` |
| `closingIssuesReferences.nodes.number`  | FR-006a linkage predicate LHS                 | FR-006a        |
| `closingIssuesReferences.nodes.repository.nameWithOwner` | FR-006a cross-repo comparison       | FR-006a        |

### Pagination

`closingIssuesReferences(first: 20)` — GitHub's realistic upper bound. If the operator hits >20 closing issues on a single PR, we accept the risk that the linkage predicate returns `false` for a legitimate linkage. Follow-up: chunked pagination is trivial to add if needed; not blocking #913.

### Failure semantics

- `gh api graphql` non-zero exit → throw (exit 1).
- `data.repository == null` OR `data.repository.pullRequest == null` → throw `Error("PR #<n> not found in <repo>")` (exit 1).
- zod parse failure → throw via `formatShapeMismatchError` with 512-char excerpt and `gh --version` (FR-009 / FR-010 apply to `--pr` too).

## §4 — Version-string capture (FR-009 / FR-010)

`captureGhVersion(runner: CommandRunner): Promise<string>`:

- Invokes `gh --version` via the same runner (dependency-injectable for tests).
- Non-zero exit → return `'unknown'` (FR-010).
- Zero exit → return `stdout.split('\n')[0].trim() || 'unknown'`.

`formatShapeMismatchError(siteLabel, rawPayload, errorMessage, ghVersion): Error`:

Message template:
```
gh <siteLabel> JSON shape mismatch: <errorMessage> (gh version: <ghVersion>; payload excerpt: <rawPayload sliced to 512 chars>)
```

The template is a single string with no line breaks — pino / stderr / tail-into-linter tooling all consume it as one log record.

## §5 — Test-time contract assertions

Per FR-011, FR-012c, FR-013, and SC-005 / SC-009, the following invariants MUST be assertable via unit tests without hitting the real gh binary:

- The runner receives `gh api graphql` invocations with the **exact** selection-set token set the queries above declare. Assertion: substring match on the query argument for `mergeStateStatus`, `closingIssuesReferences`, and `nameWithOwner` (three of the fields most likely to be silently dropped).
- The retry timing gap between attempt 1 and attempt 2 for the tier-1 follow-up is `≥ 990ms` and `≤ 1500ms` (accommodates event-loop scheduling; tolerates test-runner noise).
- On second-attempt failure, zero calls to `gh pr list --search` (tier-2) occur. Assertion: runner spy `.mock.calls.filter(c => c[1][0] === 'pr' && c[1][1] === 'list').length === 0`.
- `formatShapeMismatchError` output always contains the substring `gh version:` — the SC-005 grep guard.

## §6 — What this contract does NOT do

- Does not pin the gh CLI version (Out-of-Scope §).
- Does not audit other `--json` call sites in `wrapper.ts` (Out-of-Scope §).
- Does not add a general-purpose `gh api graphql` helper on `GhWrapper`. The two callers (`queryTier1FollowupGraphql` and `getPullRequestGraphqlDetail`) invoke `gh api graphql` directly. When a third call site materializes, extract.
