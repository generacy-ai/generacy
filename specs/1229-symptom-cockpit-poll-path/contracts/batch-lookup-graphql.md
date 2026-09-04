# Contract: Batched exact-lookup GraphQL query (`batchLookupIssuesOrPrs`)

Precedent: `specs/913-found-during-cockpit-v1/contracts/graphql-selection-set.md` and the
shipped `buildTier1FollowupQuery` (`packages/cockpit/src/gh/wrapper.ts:413`).

## Invocation

```
gh api graphql -F owner=<owner> -F repo=<name> -f query=<built query>
```

One invocation per repo per chunk; chunk size ≤ 100 numbers. Numbers are zod/parse-derived
integers from the epic body — never interpolated user strings (zero injection surface).

## Query shape (built by `buildBatchLookupQuery(numbers)`)

```graphql
query CockpitBatchLookup($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    r0: issueOrPullRequest(number: 47) {
      __typename
      ... on Issue {
        number title url state stateReason body createdAt
        author { login }
        labels(first: 100) { nodes { name } }
      }
      ... on PullRequest {
        number title url state body createdAt
        author { login }
        labels(first: 100) { nodes { name } }
      }
    }
    r1: issueOrPullRequest(number: 48) { …same selection… }
    # one alias per number, index-suffixed
  }
}
```

## Response contract

Success (all refs exist), exit code 0:

```json
{
  "data": {
    "repository": {
      "r0": { "__typename": "Issue", "number": 47, "state": "OPEN",
              "stateReason": null, "title": "…", "url": "https://github.com/o/r/issues/47",
              "body": "…", "createdAt": "2026-…", "author": { "login": "…" },
              "labels": { "nodes": [ { "name": "phase:plan" } ] } },
      "r1": { "__typename": "PullRequest", "number": 48, "state": "MERGED",
              "title": "…", "url": "https://github.com/o/r/pull/48", "body": "…",
              "createdAt": "2026-…", "author": null,
              "labels": { "nodes": [] } }
    }
  }
}
```

Partial (some refs nonexistent) — **exit code non-zero**, body still printed:

```json
{
  "data": { "repository": { "r0": { "__typename": "Issue", … }, "r1": null } },
  "errors": [
    { "type": "NOT_FOUND", "path": ["repository", "r1"],
      "message": "Could not resolve to an issue or pull request with the number of 999." }
  ]
}
```

## Wrapper semantics

| Condition | Behavior |
|---|---|
| exit 0, valid envelope | map non-null aliases → `Issue[]` |
| exit ≠ 0, parseable envelope, all `errors[].type === "NOT_FOUND"` | accept partial `data`; missing refs absent from result |
| exit ≠ 0, any non-NOT_FOUND error or unparseable stdout | throw (`failIfNonZero` / `formatShapeMismatchError` conventions, site label `api graphql (batchLookupIssuesOrPrs)`) |
| envelope shape mismatch (zod) | throw `formatShapeMismatchError` with gh version + 512-char excerpt |
| `numbers.length === 0` | resolve `[]`, no subprocess call |

Mapping rules (see `data-model.md`): PR `MERGED → state: 'CLOSED'`; PR
`stateReason: null`; `labels.nodes[].name → string[]`; `author` null → field omitted.

## Budget contract (FR-004 / SC-003)

Per poll cycle, per repo with N in-scope refs (N ≤ 100): exactly **1** GraphQL call,
replacing ≥1 paginated `gh search issues` REST calls. Per-PR calls remain gated by
`derivePrChecksNeeded` / `derivePrLifecycle`, pinned by
`cockpit-graphql-budget.integration.test.ts` (≤30 check fetches, ≤6 pr-view per 120
cycles for 4 PRs). `search issues` count on the poll path: **0**.
