# Quickstart

## What this feature ships

- New client method `GitHubClient.getIssueCommentsWithViewerAuth()` (GraphQL, populates `viewerDidAuthor` per comment).
- `integrateClarificationAnswers` (`clarification-poster.ts`) and `buildTrustedIssueCommentsBlock` (`clarify.ts`) migrated to it.
- `comment-trust.ts:111` warn extended to `answer-scanner` + `clarify-resume` surfaces.
- Retry-once + fail-closed on transient GraphQL failure — no REST fallback.
- Permanent regression test: trusted self-authored comment + question marker → `integrated == 0` (enforces #51 ordering forever).

## Prerequisites

- **#51 (question-marker exclusion, `isQuestionComment`) must be merged first.** This PR references `isQuestionComment` on the migrated fetch path; if #51 slips, this PR blocks.
- Node.js >=22 (repo-wide requirement).
- `gh` CLI installed (repo-wide requirement).
- GitHub App identity (for the meaningful test path) — but personal-auth clusters continue to work unchanged.

## Verification steps (post-merge)

### On an App-auth cluster (the fix path)

1. Trigger the cockpit auto-mode clarification gate on any spec-driven issue.
2. Approve answers via the cockpit clarify workflow so the cluster posts its own answer comment.
3. Expected:
   - Cluster-authored comment ingested by the answer-scanner (`integrated >= 1`).
   - No operator hand-post from a personal account required.
   - Gate transitions past clarification without a dead-end.

### On a personal-auth cluster (regression check)

1. Trigger the same gate on a personal-auth cluster where `GH_USERNAME` is set by the legacy `setup/auth.ts` path.
2. Expected: unchanged behavior — cluster's own answers ingested via the `botLogin` trust path (`reason: 'bot'`), same as pre-#910.

### Third-party comment (regression check)

1. On any cluster, have a stranger post a `Q1: A` comment on the clarification issue.
2. Expected: comment rejected as untrusted (`reason: 'none-untrusted'`), untrusted-answer explainer posted, gate does NOT self-advance.

## Test suite

```bash
# From repo root
pnpm --filter=@generacy-ai/workflow-engine test                     # covers comment-trust.ts warn scope
pnpm --filter=@generacy-ai/workflow-engine test client              # covers gh-cli getIssueCommentsWithViewerAuth
pnpm --filter=@generacy-ai/workflow-engine test clarify-trust       # covers clarify-resume surface
pnpm --filter=@generacy-ai/orchestrator test clarification-poster   # covers answer-scanner surface + retry + question-marker regression
```

Expected: all new tests pass; existing tests unaffected.

## Troubleshooting

### The `viewerDidAuthor missing/non-boolean` warn is firing

This is the FR-004 shape-drift alarm. Root causes to check, in order:
1. A caller of `getIssueComments()` (REST) is passing results through `isTrustedCommentAuthor` — should be using `getIssueCommentsWithViewerAuth()` instead. This is the wrong-method trap Q2-A intentionally exposes.
2. A test fixture is stubbing the client to return REST-shaped comments (no `viewerDidAuthor`) but exercising a migrated surface. Upgrade the fixture to include `viewerDidAuthor` field.
3. GraphQL response shape drift (e.g. GitHub schema change on the `IssueComment.viewerDidAuthor` field). Unlikely; verify the raw `gh api graphql` output.

### Clarification gate still dead-ends on an App-auth cluster

Check the orchestrator log for:
- `getIssueCommentsWithViewerAuth failed twice; failing closed (no REST fallback)` — GraphQL is repeatedly failing. Investigate rate limits / network / auth. Gate will resume on the next successful poll cycle.
- `comment-skipped surface=answer-scanner ... reason=self-authored` never appears — the comment fetch is not returning `viewerDidAuthor: true` for cluster-authored comments. Verify the GraphQL query includes `viewerDidAuthor` and that the cluster is authenticating as the correct App identity (`gh auth status` won't help on installation tokens; check the cluster API key).

### `integrated == 0` on a trusted self-authored comment

If SC-009's regression test fails, `isQuestionComment()` may have been reverted or moved after `parseAnswersFromComments`. The regression fixture proves the ordering — if it fails, block the merge and restore the pre-parse call.

## Rollback

Revert the PR. The `getIssueComments()` REST method is unchanged; unrelated callers (`epic/update-status.ts`, `workflow/update-stage.ts`) are unaffected. The regression is that App-auth clusters return to the dead-end state — no data corruption, no persistent state affected.

## Follow-ups (out of scope)

- If FR-008 grep-audit surfaces additional self-trust-evaluating `getIssueComments()` callers, file per-surface follow-up issues (Q5 → B); do NOT bundle into this PR.
- Deleting `resolveBotLoginFromEnv()` and the `CLUSTER_GITHUB_USERNAME`/`GH_USERNAME` env chain — kept as secondary tier (FR-006); deletion is a separate call already deferred in #878.
- Scaffolder / cloud-deploy / wizard changes to provision `CLUSTER_GITHUB_USERNAME` — explicitly rejected as the band-aid alternative (spec §Fix).
