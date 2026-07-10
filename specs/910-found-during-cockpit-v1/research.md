# Research: viewerDidAuthor migration for answer-scanner + clarify-resume

## Precedent — how #878 shaped `getPRReviewThreads()`

The `pr-feedback` surface was migrated in #878 with the following design choices, which this PR mirrors:

- **Sibling method, not mutation**: PR review threads are a GraphQL-only concept (thread resolution isn't in REST), so a new method was added rather than mutating `getPRComments()`. `getPRComments()` was marked `@deprecated`, but `getIssueComments()` is NOT deprecated here — it has legitimate non-trust-evaluating callers (`epic/update-status.ts`, `workflow/update-stage.ts`) that should keep the cheaper REST path.
- **Query shape** (`packages/workflow-engine/src/actions/github/client/gh-cli.ts:499-604`): single `gh api graphql` call, `first: 100` cap, nested `comments.nodes { databaseId, body, author { login }, authorAssociation, createdAt, updatedAt, viewerDidAuthor }`. Response mapped to `Comment[]` with `viewerDidAuthor` copied only when non-null.
- **`viewerDidAuthor` semantics**: keyed on the authenticated GitHub App identity (installation-token invariant); stable across hourly token rotation. Returns `true` when the current viewer is the comment author.

## Why REST cannot solve this

`GET /repos/{owner}/{repo}/issues/{n}/comments` does not expose `viewerDidAuthor` — it's a GraphQL-only field. The pre-#878 mechanism for self-recognition relied on comparing `comment.author.login` to a configured bot login (from `CLUSTER_GITHUB_USERNAME` / `GH_USERNAME` env vars). Two failure modes on App-auth clusters:
1. **Env vars never provisioned** — `resolveBotLoginFromEnv()` returns `undefined`. Scaffolder + entrypoint paths only write these env vars on legacy personal-auth clusters.
2. **App-token identity is opaque** — `gh api /user` fails on installation tokens; `gh auth status` returns "not logged into any GitHub hosts" (per-call token injection). No fallback identity source exists.

Net: on App-auth clusters, `botLogin` is `undefined`, `viewerDidAuthor` is absent (REST fetch), `authorAssociation` is `NONE` (Apps are not OWNER/MEMBER/COLLABORATOR), and every self-authored comment falls through to the untrusted branch of `isTrustedCommentAuthor`.

## Decision matrix — client-method shape

| Option | Blast radius | Wrong-method trap | Return-type complexity | Chosen? |
|--------|--------------|-------------------|------------------------|---------|
| A. Sibling method `getIssueCommentsWithViewerAuth()` | Two surfaces migrated; two unrelated callers untouched | Yes — but Q1-A converts silent → loud warn | Single, unconditional shape | ✅ (Q2) |
| B. Mutate `getIssueComments()` to always populate `viewerDidAuthor` | All 4 callers pay one extra GraphQL call/fetch | No | Single shape, but changes semantics | ❌ |
| C. Options flag `{ includeViewerAuth: true }` on `getIssueComments()` | One method, opt-in cost | Yes — same as A | Conditional return type; contract complexity | ❌ |

Q2 → A: mirrors #878 precedent, keeps trust dependency visible at every call site, leaves REST callers untouched.

## Decision matrix — warn scope for `viewerDidAuthor` absent

| Option | Steady-state noise (healthy) | Broken-migration signal | Fixture upgrade required | Chosen? |
|--------|------------------------------|-------------------------|--------------------------|---------|
| A. Extend to answer-scanner + clarify-resume | Zero (field always present post-migration) | Loud warn on shape drift | Yes — fixtures must populate `viewerDidAuthor` | ✅ (Q1) |
| B. Keep scoped to pr-feedback only | Zero | None on new surfaces — silent recreation of this defect class | No | ❌ |
| C. Extend but downgrade to `debug`/`info` | Zero | Muted alarm on new surfaces | No | ❌ |

Q1 → A: extended warn is the recursive fix for this defect class ("silently-broken GraphQL migration produces no warn"). Fixtures are cheap to upgrade; production signal is expensive to reintroduce.

## Decision matrix — transient GraphQL failure behavior

| Option | Silent recreates defect? | Operator-visible pause on single blip | Complexity | Chosen? |
|--------|--------------------------|---------------------------------------|------------|---------|
| A. Fail closed, no retry | No | Yes (full poll cycle) | Trivial | ❌ |
| B. Retry once, then fail closed | No | Absorbs single blip | +1 retry line | ✅ (Q4) |
| C. Fall back to REST | **YES — reproduces pre-fix defect** | No | Adds fallback path | ❌ |

Q4 → B: highest-frequency gate + secondary rate limits are routine; one retry is cheap insurance. Never fall back to REST — under Q1-A the REST fallback would additionally fire the absent-field warn, making degraded cycles both noisy and broken.

## Decision matrix — #51 dependency enforcement

| Option | Enforces at land | Survives post-merge revert | Illusory in TS? | Chosen? |
|--------|-------------------|-----------------------------|-----------------|---------|
| A. Merge-order convention only | Depends on reviewer | No | N/A | ❌ |
| B. PR-level check + permanent test | Yes | Yes — test fails CI forever | No | ✅ (Q3) |
| C. Runtime guard | Yes | Superficially — but revert removes import + guard together | Yes | ❌ |

Q3 → B: static import in compiled TS means C's guard protects against an unrepresentable state. B's regression test (trusted self-authored comment + question marker → `integrated == 0`) is strictly stronger — it fails CI on both merge-order violations AND future reverts.

## Decision matrix — FR-008 audit outcome

| Option | Atomic PR | Bounded review | Handles surprise surfaces | Chosen? |
|--------|-----------|----------------|---------------------------|---------|
| A. Migrate all found surfaces | Yes | Blast radius grows with audit result | Same PR | ❌ |
| B. Spin out per-surface follow-ups | Not perfectly atomic (expected result is zero surprises) | Yes | Own issue + regression fixtures | ✅ (Q5) |
| C. Case-by-case | No | Ambiguous at implement time | Runtime decision | ❌ |

Q5 → B: expected audit result is zero surprises (pr-feedback already migrated in #878). If a fourth surface appears, folding it in trades a bounded change for an open-ended one — each surface's edge cases (dedupe wedging, `[bot]` normalization, by-design absence) deserve their own examination.

## Implementation pattern

The GraphQL query for issue comments mirrors `getPRReviewThreads()`:

```graphql
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      comments(first: 100) {
        nodes {
          databaseId
          body
          createdAt
          updatedAt
          author { login }
          authorAssociation
          viewerDidAuthor
        }
      }
    }
  }
}
```

Executed via existing `executeGh(['api', 'graphql', '-f', 'query=…', '-F', 'owner=…', '-F', 'repo=…', '-F', 'number=…'])` helper. Response mapped to `Comment[]` with `viewerDidAuthor` populated when non-null (matches lines 591-593 of `gh-cli.ts`).

Pagination: `first: 100` matches the review-threads precedent. Issue comment threads exceeding this cap are out-of-scope for this feature (spec does not raise it); the same posture is inherited from #878.

## Sources

- `packages/workflow-engine/src/actions/github/client/gh-cli.ts:499-604` — precedent GraphQL query for review threads
- `packages/workflow-engine/src/security/comment-trust.ts:83-157` — `isTrustedCommentAuthor` decision matrix; line 111 warn scope
- `packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts:125-175` — `buildTrustedIssueCommentsBlock` (clarify-resume surface)
- `packages/orchestrator/src/worker/clarification-poster.ts:568-660` — `integrateClarificationAnswers` (answer-scanner surface)
- `packages/workflow-engine/src/types/github.ts:72-104` — `Comment` type with optional `viewerDidAuthor`
- GitHub GraphQL v4 schema — `IssueComment.viewerDidAuthor: Boolean!` (nullable on federation edges only)
- #878 PR body — self-recognition primitive rationale
