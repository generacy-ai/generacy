# Data Model: `viewerDidAuthor` self-authored trust

## Modified Entities

### `Comment` (`packages/workflow-engine/src/types/github.ts`)

Add one optional field:

```ts
export interface Comment {
  id: number;
  body: string;
  author: string;
  created_at: string;
  updated_at: string;
  path?: string;
  line?: number;
  in_reply_to_id?: number;
  /** @deprecated (unchanged from current state) */
  resolved?: boolean;
  authorAssociation?: string;

  /**
   * True iff GitHub reports the comment was authored by the credential
   * making the query (GraphQL's `viewerDidAuthor` on
   * `PullRequestReviewComment`). Populated by `getPRReviewThreads()` only.
   * Undefined on comments fetched from any other client (fixture / cache /
   * REST). The pr-feedback trust predicate treats non-`true` (`false` /
   * `undefined` / `null` at wire level) as *not* self-authored and, when
   * non-boolean, emits a `warn` log.
   */
  viewerDidAuthor?: boolean;
}
```

**Populated only** by `GhCliGitHubClient.getPRReviewThreads()` from the GraphQL query response. Other client methods (REST, fixture builders, cached responses) leave it `undefined`.

**Validation rule**: none at the type layer. The predicate's `viewerDidAuthor === true` check is defensive by construction.

### `ReviewThread` (`packages/workflow-engine/src/types/github.ts`)

Unchanged — inherits the new field via its `comments: Comment[]` field.

### `TrustReason` union (`packages/workflow-engine/src/security/comment-trust.ts`)

**Rename** one entry:

```ts
export type TrustReason =
  | 'owner'
  | 'member'
  | 'collaborator'
  | 'bot'
  | 'self-authored'          // ← was 'cluster-identity'
  | 'widened-tier'
  | 'widened-login'
  | 'none-untrusted'
  | 'first-timer-untrusted'
  | 'first-time-contributor-untrusted'
  | 'mannequin-untrusted'
  | 'contributor-untrusted'
  | 'author-association-unset'
  | 'unknown-tier';
```

**Hard rename** (Q1→D). No dual-emit. Callers key on the union — the TS compiler flags every consumer of the old string.

### `CommentTrustContext` (`packages/workflow-engine/src/security/comment-trust.ts`)

**Remove** the `clusterIdentity` field:

```ts
export interface CommentTrustContext {
  botLogin?: string;
  // clusterIdentity?: string;   ← REMOVED
  config?: CommentTrustConfig;
  logger: Logger;
}
```

Callers stop threading `clusterIdentity` from `PrFeedbackMonitorService` / `PrFeedbackHandler`. The self-authored signal now lives on the comment itself.

## Removed Entities

### `resolveActingIdentity(logger)` (`packages/orchestrator/src/services/acting-identity.ts`)

**Deleted in full.** Function signature, file, and companion test file (`__tests__/acting-identity.test.ts`) are removed. No replacement — the mechanism it served is dissolved by `viewerDidAuthor`.

### `normalizeLogin(raw)` (`packages/workflow-engine/src/security/comment-trust.ts`)

**Retained** — still called by decision 1 (`botLogin` comparison, out of scope for this feature). Only its decision-1.5 (`clusterIdentity`) call site is removed. The 16 fixture pairs that exercised it via cluster-identity are deleted; the bot-login fixtures (a smaller separate set) stay.

### `ScaffoldEnvInput.actingLogin` (`packages/generacy/src/cli/commands/cluster/scaffolder.ts`)

**Deleted.** Field, interpolation block (`actingLoginLines`), and the `CLUSTER_ACTING_LOGIN=` line in the generated `.env`.

### `LaunchConfigSchema.actingLogin` (`packages/generacy/src/cli/commands/launch/types.ts`)

**Deleted.** Removed from the Zod schema.

### `PrFeedbackMonitorService(..., actingIdentity)` constructor parameter

**Deleted.** Field and threading.

### `PrFeedbackHandler(..., clusterIdentity)` constructor parameter

**Deleted.** Field, FR-006 degraded-mode error log block, and threading.

## Modified Skip-warn Evidence Shape

**Before** (from `pr-feedback-handler.ts` line ~272–288 and `pr-feedback-monitor-service.ts` line ~298–314):

```jsonc
{
  "prNumber": ..., "issueNumber": ..., "owner": ..., "repo": ...,
  "totalUnresolvedThreads": ...,
  "clusterIdentity": "generacy-ai" | null,             // ← top-level, removed
  "normalizedClusterIdentity": "generacy-ai" | null,   // ← top-level, removed
  "untrustedSkips": [
    {
      "commentId": ...,
      "author": "...",
      "authorAssociation": "...",
      "reason": "none-untrusted",
      "normalizedAuthor": "..."                        // ← per-skip, removed
    }
  ]
}
```

**After**:

```jsonc
{
  "prNumber": ..., "issueNumber": ..., "owner": ..., "repo": ...,
  "totalUnresolvedThreads": ...,
  "untrustedSkips": [
    {
      "commentId": ...,
      "author": "...",
      "authorAssociation": "...",
      "reason": "none-untrusted",
      "viewerDidAuthor": true | false | null           // ← NEW per-skip
    }
  ]
}
```

**Same shape applies** to the "comment-skipped" info log at pr-feedback-handler.ts line ~212–227: drop `normalizedAuthor` / `clusterIdentity` / `normalizedClusterIdentity`; add `viewerDidAuthor`.

## Missing-field warn log

Emitted by `isTrustedCommentAuthor` at decision 1.5 when `comment.viewerDidAuthor` is not the literal boolean `false` (i.e., is `undefined` or `null`):

```jsonc
{
  "commentId": ...,
  "observedValue": null | undefined
}
"viewerDidAuthor missing/non-boolean on comment; treating as not self-authored"
```

One log per comment per predicate call. Not suppressed / rate-limited (matches #874 Q4 shape).

## Relationships

- `Comment.viewerDidAuthor` is populated **only** by `getPRReviewThreads()`. If FR-007's grep-audit surfaces a consumer that reads comments via any other client, that consumer must migrate to `getPRReviewThreads()` (Q2→B). No parallel authorship-inference path is allowed to resurrect.
- `TrustReason === 'self-authored'` is emitted **only** by decision 1.5 on the `'pr-feedback'` surface. The `'answer-scanner'` and `'clarify-resume'` surfaces never emit it (they don't consume `viewerDidAuthor`; their `botLogin` rule serves the opposite goal — exclusion).

---

*Generated by speckit*
