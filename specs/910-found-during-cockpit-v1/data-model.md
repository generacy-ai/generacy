# Data Model

This feature adds no new persistent entities. It re-uses existing shared types and adds one client method. Below: the types touched, their existing shape, and the semantic contract each field participates in.

## Existing types (re-used, unchanged)

### `Comment` — `packages/workflow-engine/src/types/github.ts:72-104`

```typescript
export interface Comment {
  id: number;                       // GitHub numeric comment ID (databaseId in GraphQL)
  body: string;                     // raw markdown
  author: string;                   // login string (REST: 'foo[bot]'; GraphQL: 'foo')
  created_at: string;               // ISO 8601
  updated_at: string;               // ISO 8601
  path?: string;                    // review-comment only
  line?: number;                    // review-comment only
  in_reply_to_id?: number;          // review-comment only
  authorAssociation?: string;       // GitHub CommentAuthorAssociation enum: OWNER/MEMBER/COLLABORATOR/CONTRIBUTOR/FIRST_TIME_CONTRIBUTOR/FIRST_TIMER/MANNEQUIN/NONE
  viewerDidAuthor?: boolean;        // GraphQL-only, populated by getPRReviewThreads() today; getIssueCommentsWithViewerAuth() (new) after this PR
  resolved?: boolean;               // review-thread only
}
```

**Field semantics touched by this feature**:

- `viewerDidAuthor`:
  - **Populated by**: existing `getPRReviewThreads()`; NEW `getIssueCommentsWithViewerAuth()`
  - **NOT populated by**: `getIssueComments()` (REST), `getPRComments()` (REST, deprecated)
  - **Semantic**: `true` iff the authenticated GitHub App identity authored the comment. Stable across installation-token rotation (keyed on App, not token).
  - **Trust contract**: `viewerDidAuthor === true` → `{ trusted: true, reason: 'self-authored' }` (rule 1.5 in `isTrustedCommentAuthor`).

- `authorAssociation`:
  - **Values leading to trust**: `OWNER`, `MEMBER`, `COLLABORATOR` (default) + widen-config tiers (non-answer-scanner surfaces)
  - **Values leading to distrust**: `NONE`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`, `MANNEQUIN`, `CONTRIBUTOR`
  - **On App-auth clusters**: cluster's own comments arrive with `authorAssociation: 'NONE'` (Apps are not org members) — this is why `viewerDidAuthor` matters.

### `TrustSurface` — `packages/workflow-engine/src/security/comment-trust.ts:13`

```typescript
export type TrustSurface = 'answer-scanner' | 'clarify-resume' | 'pr-feedback';
```

Unchanged. All three surfaces already exist. This PR changes how the answer-scanner and clarify-resume surfaces *reach* `isTrustedCommentAuthor` (via GraphQL fetch), not which surfaces exist.

### `TrustDecision` / `TrustReason` — `packages/workflow-engine/src/security/comment-trust.ts:15-34`

```typescript
export type TrustReason =
  | 'owner' | 'member' | 'collaborator'
  | 'bot' | 'self-authored'
  | 'widened-tier' | 'widened-login'
  | 'none-untrusted' | 'first-timer-untrusted' | 'first-time-contributor-untrusted'
  | 'mannequin-untrusted' | 'contributor-untrusted'
  | 'author-association-unset' | 'unknown-tier';

export interface TrustDecision {
  trusted: boolean;
  reason: TrustReason;
}
```

Unchanged. `'self-authored'` reason is the target outcome for cluster-self-authored comments on App-auth clusters (SC-002).

### `CommentTrustContext` — `packages/workflow-engine/src/security/comment-trust.ts:36-40`

```typescript
export interface CommentTrustContext {
  botLogin?: string;
  config?: CommentTrustConfig;
  logger: Logger;
}
```

Unchanged. `botLogin` remains optional and continues to serve personal-auth clusters via the env chain (FR-006).

## New client method

### `getIssueCommentsWithViewerAuth` — added to `GitHubClient` interface

```typescript
/**
 * Fetch issue comments via GraphQL with `viewerDidAuthor` populated.
 *
 * Use this method (not `getIssueComments()`) on any surface that passes
 * comments through `isTrustedCommentAuthor` — the trust decision depends
 * on `viewerDidAuthor` for App-identity self-recognition (#878, #910).
 *
 * Callers today: `integrateClarificationAnswers` (clarification-poster),
 * `buildTrustedIssueCommentsBlock` (clarify.ts).
 *
 * @throws GhAuthError on HTTP 401 or 403.
 * @throws Error on any other non-zero exit.
 */
getIssueCommentsWithViewerAuth(owner: string, repo: string, number: number): Promise<Comment[]>;
```

**Return contract**:
- `Comment[]` sorted by GitHub's default (creation order).
- Each `Comment` has `viewerDidAuthor: boolean` populated when GraphQL returned a non-null value. Absent otherwise (treated by the trust helper as "not self-authored" — decision falls through to tier evaluation).
- `id` = GitHub numeric comment ID (`databaseId`), matching REST semantics for downstream consumers (e.g. `postUntrustedAnswerExplainers` writes idempotence markers keyed on this ID).
- `author` = normalized login string from GraphQL (no `[bot]` suffix — matches `getPRReviewThreads()` shape). `normalizeLogin()` in `comment-trust.ts` accounts for both shapes.

## Validation rules

- **`viewerDidAuthor` presence** (FR-004 / Q1 → A): on the migrated surfaces (`answer-scanner`, `clarify-resume`), an absent or non-boolean `viewerDidAuthor` triggers a `logger.warn` in `comment-trust.ts:111`. On the healthy path the field is always populated by `getIssueCommentsWithViewerAuth()`, so the warn never fires in steady state — it is a shape-drift alarm.
- **Retry-once contract** (FR-010 / Q4 → B): on transient GraphQL failure, the fetch retries once against GraphQL. Second failure → fail closed: `integrated == 0`, warn logged with the GraphQL error, gate stays paused. No REST fallback path exists.
- **Question-marker exclusion** (FR-007 / Q3 → B): the migrated answer-scanner path MUST call `isQuestionComment(c.body)` before `parseAnswersFromComments`. A trusted self-authored comment carrying `<!-- generacy-clarifications:<id> -->` MUST yield `integrated == 0` (permanent regression test).

## Relationships

```
LabelMonitor / worker phase loop
     │
     ▼
integrateClarificationAnswers (orchestrator)  ─┐
     │                                          │  both call:
     │  swap: getIssueComments() → getIssueCommentsWithViewerAuth()
     │                                          │
buildTrustedIssueCommentsBlock (workflow-engine)┘
     │
     ▼
GitHubClient.getIssueCommentsWithViewerAuth() ── executes GraphQL via `gh api graphql` ──▶ returns Comment[] with viewerDidAuthor
     │
     ▼
for each comment: isTrustedCommentAuthor(c, surface, ctx)
                                        │
                                        ├─ viewerDidAuthor === true  →  { trusted: true,  reason: 'self-authored' }   ← target outcome
                                        ├─ botLogin match             →  { trusted: true,  reason: 'bot' }              ← personal-auth path
                                        ├─ trusted tier (OWNER/…)     →  { trusted: true,  reason: <tier> }
                                        ├─ widen-config (non-scanner) →  { trusted: true,  reason: 'widened-*' }
                                        └─ else                        →  { trusted: false, reason: <untrusted> }
```

## Out-of-model

- No new persistent state, no schema migration, no config file changes.
- `.agency/credentials.yaml` / cluster env / registry: unchanged.
- No new relay message types, no cloud-side schema updates.
