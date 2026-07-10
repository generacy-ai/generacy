# Contract: `getIssueCommentsWithViewerAuth`

New method on `GitHubClient` (interface + `GhCliGitHubClient` implementation). Sibling to `getIssueComments()` (REST) and mirror of `getPRReviewThreads()` (existing GraphQL precedent from #878).

## Signature

```typescript
getIssueCommentsWithViewerAuth(
  owner: string,
  repo: string,
  number: number,
): Promise<Comment[]>;
```

## GraphQL query

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

Executed via `this.executeGh(['api', 'graphql', '-f', 'query=…', '-F', 'owner=…', '-F', 'repo=…', '-F', 'number=…'])`.

## Response mapping

Each GraphQL comment node maps to a `Comment` object as follows:

| GraphQL field | Type | Comment field | Notes |
|---------------|------|---------------|-------|
| `databaseId` | `number` | `id` | Numeric ID (matches REST); load-bearing for downstream `postUntrustedAnswerExplainers` markers. |
| `body` | `string` | `body` | Raw markdown. |
| `author.login` | `string \| null` | `author` | Fallback to `''` on null (matches `getPRReviewThreads()` at gh-cli.ts:579). |
| `authorAssociation` | `string \| null` | `authorAssociation` | Copied when non-null. |
| `createdAt` | `string` | `created_at` | ISO 8601. |
| `updatedAt` | `string` | `updated_at` | ISO 8601. |
| `viewerDidAuthor` | `boolean \| null` | `viewerDidAuthor` | Copied when non-null. Absence → treated as "not self-authored" by trust helper. |

## Error surface

- **HTTP 401/403** → `throw new GhAuthError(...)` (existing `executeGh` behavior — auth-error detection at gh-cli.ts).
- **Any other non-zero exit** → `throw new Error(`Failed to get issue comments for issue #${number}: ${result.stderr}`)` (matches `getPRReviewThreads()` shape at gh-cli.ts:536).
- **GraphQL response with no data node** → return `[]` (matches `getPRReviewThreads()` at gh-cli.ts:569).

## Pagination

`first: 100` fixed cap. If issue comment threads exceed 100, this method returns the first page only — same posture as `getPRReviewThreads()`. Spec does not raise pagination; out-of-scope for this PR.

## Trust helper contract preserved

Callers of this method MUST pass returned comments through `isTrustedCommentAuthor(c, surface, ctx)` before treating any comment as authoritative. The surface parameter MUST be one of `'answer-scanner'` or `'clarify-resume'` — `'pr-feedback'` is served by the existing `getPRReviewThreads()`.

## Caller contract (FR-002, FR-003)

Both migrated callers replace exactly one line:

**`packages/orchestrator/src/worker/clarification-poster.ts` line 603**:

```diff
-    comments = await github.getIssueComments(owner, repo, issueNumber);
+    comments = await getIssueCommentsWithRetry(github, owner, repo, issueNumber, logger);
```

Where `getIssueCommentsWithRetry` is a local helper implementing FR-010 (retry once, fail closed):

```typescript
async function getIssueCommentsWithRetry(
  github: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
  logger: Logger,
): Promise<Comment[]> {
  try {
    return await github.getIssueCommentsWithViewerAuth(owner, repo, issueNumber);
  } catch (firstErr) {
    logger.warn(
      { error: firstErr instanceof Error ? firstErr.message : String(firstErr) },
      'getIssueCommentsWithViewerAuth failed; retrying once',
    );
    try {
      return await github.getIssueCommentsWithViewerAuth(owner, repo, issueNumber);
    } catch (secondErr) {
      logger.warn(
        { error: secondErr instanceof Error ? secondErr.message : String(secondErr) },
        'getIssueCommentsWithViewerAuth failed twice; failing closed (no REST fallback)',
      );
      throw secondErr;
    }
  }
}
```

The outer `try/catch` at line 604 already routes to `return { integrated: 0, reason: 'no-answers' }` on failure — no additional gate-pause logic needed.

**`packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts` line 137**:

```diff
-    comments = await client.getIssueComments(repoInfo.owner, repoInfo.repo, issueNumber);
+    comments = await client.getIssueCommentsWithViewerAuth(repoInfo.owner, repoInfo.repo, issueNumber);
```

`buildTrustedIssueCommentsBlock` swallows fetch errors and returns `(no comments available)` — this behavior is preserved. Retry-once is added here too (same helper, inlined or shared — implement decides).

## `comment-trust.ts` warn-scope contract (FR-004 / Q1 → A)

Line ~111 currently reads:

```typescript
if (surface === 'pr-feedback' && comment.viewerDidAuthor !== false) {
  ctx.logger.warn(...);
}
```

After this PR:

```typescript
if (
  (surface === 'pr-feedback' || surface === 'answer-scanner' || surface === 'clarify-resume') &&
  comment.viewerDidAuthor !== false
) {
  ctx.logger.warn(
    'viewerDidAuthor missing/non-boolean on comment; treating as not self-authored',
    { surface, commentId: comment.id, observedValue: comment.viewerDidAuthor },
  );
}
```

`surface` added to the warn payload so log audits can distinguish drift by surface (SC-006). Equivalent form using a `Set<TrustSurface>` constant `MIGRATED_SURFACES` is acceptable if preferred; behavior identical.

## Test contract

The client-method unit test (`gh-cli-get-issue-comments-with-viewer-auth.test.ts`) asserts:

- The `executeGh` call includes `'api'`, `'graphql'`, and a `-f query=…` argument whose value contains the string `viewerDidAuthor` (case-sensitive).
- Response mapping copies `databaseId` → `id`, `viewerDidAuthor: true` → `viewerDidAuthor: true`, `viewerDidAuthor: null` → field absent on returned `Comment`.
- Non-zero exit surfaces the stderr in the thrown `Error.message`.
- HTTP 401 → `GhAuthError` (via `executeGh`).
