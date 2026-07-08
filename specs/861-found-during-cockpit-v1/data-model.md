# Data Model: Thread-shaped review API (#861)

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

## Types

### `ReviewThread` (NEW)

**Location**: `packages/workflow-engine/src/types/github.ts`

```typescript
/**
 * A GitHub PR review thread, as reported by GraphQL
 * `pullRequest.reviewThreads`. Resolution is a property of the thread —
 * NOT of individual comments. Do not add a `resolved` field to `Comment`.
 * See #861.
 */
export interface ReviewThread {
  /** databaseId of the first (root) comment in the thread. Stable identifier. */
  rootCommentId: number;
  /** True when the thread has been marked resolved in the GitHub UI. */
  isResolved: boolean;
  /** All comments in the thread, in chronological order. */
  comments: Comment[];
}
```

### `Comment` (MODIFIED — deprecation only)

**Location**: `packages/workflow-engine/src/types/github.ts:72-88`

```typescript
export interface Comment {
  id: number;
  body: string;
  author: string;
  created_at: string;
  updated_at: string;
  path?: string;
  line?: number;
  in_reply_to_id?: number;
  /**
   * @deprecated The REST endpoint never populated this field; use
   * `ReviewThread.isResolved` from `getPRReviewThreads()` instead.
   * Left in the type for one release cycle; delete in follow-up.
   */
  resolved?: boolean;
  authorAssociation?: string;
}
```

**No structural change** — only JSDoc. The field cannot be safely deleted in this PR because it appears in existing test fixture types across the workflow-engine test suite; a mechanical follow-up removes it.

### `PreflightOutput.unresolved_threads` (RENAMED)

**Location**: `packages/workflow-engine/src/types/github.ts:264-266`

Before:
```typescript
interface PreflightOutput {
  // ...
  unresolved_comments: number;
  // ...
}
```

After:
```typescript
interface PreflightOutput {
  // ...
  /**
   * Count of unresolved review threads (matches GitHub UI's
   * "N unresolved conversations" and `PrFeedbackMonitorService`'s
   * enqueue decision). Renamed from `unresolved_comments` in #861.
   */
  unresolved_threads: number;
  // ...
}
```

**Migration**:
- Same PR: rename the field in `PreflightOutput`, rename the local var in `preflight.ts:209,213,255`, update fixtures in `preflight.test.ts`.
- Verified during plan: no cross-repo or cross-package readers of `unresolved_comments` exist. See research.md D4.

### `ReadPRFeedbackOutput` (UNCHANGED shape, semantics tightened)

**Location**: `packages/workflow-engine/src/types/github.ts:455-464`

```typescript
export interface ReadPRFeedbackOutput {
  comments: Comment[];
  has_unresolved: boolean;
  unresolved_count: number;   // now = unresolved THREAD count, not comment count
  skippedComments?: SkippedCommentInfo[];
}
```

Field names kept for backward compat (external field readers are Claude prompts; renaming would perturb prompt tokens for no user-visible gain). Semantics documented: `unresolved_count` is a thread count, matching monitor + preflight after this PR.

## API surface

### `GitHubClient.getPRReviewThreads` (NEW)

**Location**: `packages/workflow-engine/src/actions/github/client/interface.ts` (interface), `gh-cli.ts` (impl)

```typescript
interface GitHubClient {
  // ... existing methods ...

  /**
   * Fetch all review threads on a PR, with resolution state, via GraphQL.
   *
   * The REST endpoint at /repos/{owner}/{repo}/pulls/{n}/comments does NOT
   * expose thread resolution — thread state is a GraphQL-only concept.
   * Callers that need per-thread resolved state MUST use this method.
   * `getPRComments()` is deprecated; do not use it for new code.
   *
   * @throws GhAuthError on HTTP 401 or 403.
   * @throws Error on any other non-zero exit.
   */
  getPRReviewThreads(
    owner: string,
    repo: string,
    number: number,
  ): Promise<ReviewThread[]>;
}
```

### `GitHubClient.getPRComments` (DEPRECATED)

```typescript
interface GitHubClient {
  /**
   * @deprecated The REST endpoint underneath this method does not expose
   * thread resolution — every returned `Comment.resolved` is `undefined`.
   * Use `getPRReviewThreads()` instead. Removed in a follow-up PR.
   */
  getPRComments(owner: string, repo: string, number: number): Promise<Comment[]>;
}
```

### `GhAuthError` (MODIFIED — widen statusCode)

**Location**: `packages/workflow-engine/src/actions/github/client/gh-cli.ts:30-39`

Before:
```typescript
export class GhAuthError extends Error {
  constructor(
    public readonly statusCode: 401,
    public readonly stderr: string,
    message?: string,
  ) { ... }
}
```

After:
```typescript
export class GhAuthError extends Error {
  constructor(
    public readonly statusCode: 401 | 403,
    public readonly stderr: string,
    message?: string,
  ) { ... }
}
```

`executeGh`'s guard at `gh-cli.ts:90` also widens: `if ([401, 403].includes(code))` throw `GhAuthError`.

## Validation rules

- `ReviewThread.comments` MUST be non-empty. GraphQL cannot return a thread with zero comments; if it does, treat as a client bug and drop the thread with a `warn` log.
- `ReviewThread.rootCommentId` MUST equal `comments[0].id`. Enforced during construction inside `getPRReviewThreads`.
- `preflight.unresolved_threads` MUST equal `reviewThreads.filter(t => !t.isResolved).length`.
- Monitor's `reviewThreadIds` MUST equal `threads.filter(t => !t.isResolved).map(t => t.rootCommentId)`.

## Entity relationships

```
PullRequest 1 ── * ReviewThread 1 ── * Comment
                          │
                          └── isResolved: boolean   (GraphQL-only)
```

Today's broken model:
```
PullRequest 1 ── * Comment (with resolved?: undefined ← REST bug)
```

## State transitions (info logging)

`PrFeedbackMonitorService` maintains in-process:
```typescript
private lastUnresolvedThreadCount: Map<string /* owner/repo#number */, number>;
```

| Previous count | Current count | Action |
|---|---|---|
| unset (bootstrap) | 0 | `info` once, then track 0 |
| unset (bootstrap) | N > 0 | `info` once, track N |
| 0 | 0 | `debug` |
| 0 | N > 0 | `info` (transition zero→unresolved) |
| N > 0 | 0 | `info` (transition unresolved→zero — matches spec's key case) |
| N > 0 | M > 0, N ≠ M | `info` (count change) |
| N > 0 | N (same) | `debug` |

Map key: `${owner}/${repo}#${prNumber}`. Never evicted (open PR set is bounded).
