# Contract: New GitHubClient methods (#1125)

Package: `@generacy-ai/workflow-engine`
Files: `src/actions/github/client/interface.ts` (declarations), `src/actions/github/client/gh-cli.ts` (`GhCliGitHubClient` impl — sole implementer), `src/types/github.ts` (types).

## createReview

```ts
createReview(owner: string, repo: string, prNumber: number, input: CreateReviewInput): Promise<Review>;
```

- **Transport**: REST `POST /repos/{owner}/{repo}/pulls/{prNumber}/reviews` via `executeGh(['api','--method','POST', path, '--input','-'])`, writing JSON to stdin:
  ```json
  { "event": "COMMENT", "body": "<body>", "comments": [ { "path": "src/x.ts", "line": 42, "side": "RIGHT", "body": "<inline>" } ] }
  ```
- **event**: caller supplies; #1125 always `COMMENT`. `REQUEST_CHANGES` on the author's own PR → GitHub 422 (SC-001 forbids emitting it — enforced at the call site + a unit test, not inside this method).
- **comments**: omit or `[]` for a body-only review. Every entry MUST anchor to a diffable line (caller's responsibility via `listPullRequestFiles`); a non-diffable line 422s the **entire** submission.
- **Returns**: the created `Review` (parse `id`, `user.login`, `body`, `state`, `submitted_at`). On non-zero exit → throw `Error` with stderr (best-effort handling is the caller's concern).
- **No retry** inside the method for a 422 (a 422 is a caller payload bug, not transient); transient network errors surface to the caller.

## convertPullRequestToDraft

```ts
convertPullRequestToDraft(owner: string, repo: string, prNumber: number): Promise<void>;
```

- **Step 1 — resolve node id + draft state** (GraphQL query):
  ```graphql
  query($owner:String!,$repo:String!,$n:Int!){ repository(owner:$owner,name:$repo){ pullRequest(number:$n){ id isDraft } } }
  ```
  If `isDraft === true` → return (idempotent no-op).
- **Step 2 — mutation**:
  ```graphql
  mutation($id:ID!){ convertPullRequestToDraft(input:{pullRequestId:$id}){ pullRequest{ id isDraft } } }
  ```
- **Execution**: `executeGh(['api','graphql','-f',`query=...`,'-F',...])`, mirroring `resolveReviewThread` (`gh-cli.ts:769`): 3× backoff `[1000,2000,4000]`, rethrow `GhAuthError`, terminal on GraphQL `errors[]`.
- **Returns** `void`. Throws on terminal failure; the caller (`PrManager`) wraps best-effort (warn, never fail the workflow — FR-008).

## listPullRequestFiles

```ts
listPullRequestFiles(owner: string, repo: string, prNumber: number): Promise<PullRequestFile[]>;
```

- **Transport**: REST `GET /repos/{owner}/{repo}/pulls/{prNumber}/files?per_page=100 --paginate`.
- **Returns**: `{ filename, status, patch? }[]`. `patch` absent for binary/too-large files (those files contribute **no** diffable lines → their anchored findings fall back to the body).
- On non-zero exit → throw with stderr.

## Type additions (`types/github.ts`)

`ReviewEvent`, `CreateReviewComment`, `CreateReviewInput`, `PullRequestFile` — see data-model.md §2. `Review`, `ReviewThread`, `Comment`, `PullRequest.draft` unchanged.

## Test contract (`gh-cli` unit tests, mock `executeCommand`/`executeGh`)

- `createReview`: builds the correct REST path; JSON stdin carries `event`/`body`/`comments[]`; returns parsed `Review`; non-zero exit throws.
- `convertPullRequestToDraft`: `isDraft:true` short-circuits (no mutation call); `isDraft:false` runs the mutation; GraphQL `errors[]` throws terminally; `GhAuthError` rethrown; transient failure retried.
- `listPullRequestFiles`: paginated path; parses `patch`; missing `patch` tolerated.
