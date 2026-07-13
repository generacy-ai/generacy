# Quickstart: PR-feedback loop fix (#869)

**Feature**: `869-found-during-cockpit-v1`
**Reader**: the engineer picking up `/speckit:tasks` after this plan.

## What ships

Four coordinated changes across two packages:

| Change | Package | File | LOC est. |
|--------|---------|------|----------|
| Add `clusterIdentity` to `CommentTrustContext` + new decision 1.5 | `workflow-engine` | `src/security/comment-trust.ts` | ~10 |
| Add `listPrCommentBodies` + `postPrComment` to `GitHubClient` | `workflow-engine` | `src/actions/github/client/{interface,gh-cli}.ts` | ~30 |
| Trust-aware pre-enqueue filter + zero-trusted notice | `orchestrator` | `src/services/pr-feedback-monitor-service.ts` | ~80 |
| Dedupe-clear on every exit + FR-002/FR-003/FR-007 handler branches | `orchestrator` | `src/worker/pr-feedback-handler.ts` | ~50 |
| Wire `phaseTracker` + `clusterIdentity` into handler | `orchestrator` | `src/worker/claude-cli-worker.ts` | ~5 |

Approx. 175 LOC production, plus tests (~150 LOC).

## Install / build

Standard monorepo workflow — no new dependencies added.

```bash
pnpm install
pnpm --filter @generacy-ai/workflow-engine build
pnpm --filter @generacy-ai/orchestrator build
```

## Running the tests

```bash
# Unit — trust predicate extension
pnpm --filter @generacy-ai/workflow-engine test comment-trust

# Unit — monitor trust-aware enqueue + notice posting
pnpm --filter @generacy-ai/orchestrator test pr-feedback-monitor-service

# Unit — handler exit paths + degraded identity
pnpm --filter @generacy-ai/orchestrator test pr-feedback-handler

# Integration — PR #14 scenario replay
pnpm --filter @generacy-ai/orchestrator test pr-feedback-integration

# All
pnpm test
```

## Live verification

The finding was observed on christrudelpw/sniplink#4 / PR #14. To replay against a live cluster:

1. Open a PR from a cluster-assigned issue. Push a commit.
2. From the cockpit's implementation-review gate, select **request-changes** and post an inline review comment.
3. Assert the log sequence in the orchestrator container:
   - `PrFeedbackMonitorService`: `Found 1 unresolved review thread(s)` → `PR feedback work enqueued`.
   - `ClaudeCliWorker`: `Routing to PrFeedbackHandler for PR feedback addressing`.
   - `PrFeedbackHandler`: `Fetched PR review threads (author-trust filtered)` with `trustedUnresolvedComments: 1`.
   - `PrFeedbackHandler`: CLI spawn → commit → push → `Removed waiting-for:address-pr-feedback label`.
4. Assert the ABSENCE of:
   - `event=comment-skipped … reason=none-untrusted` for the cluster-identity author.
   - `No unresolved threads found` while GitHub still reports `unresolvedThreads > 0`.
   - `Duplicate detected (atomic check) … Skipping duplicate` on the next poll after a new comment.

## Available commands (unchanged)

The feature does not add any new user-facing commands. The cockpit `request-changes` gate and `/generacy` CLI surfaces are unchanged.

Operator-visible behaviors:
- Untrusted-only PRs now get a top-level PR comment tagged `<!-- generacy:pr-feedback-untrusted-notice -->` — one per zero-trusted episode.
- Handler `warn` log names skipped authors + associations on the zero-trusted retention path.
- Handler `error` log names the tried chain when `clusterIdentity` is unresolvable.

## Troubleshooting

### Loop still dead after fix on the pre-existing PR #14

The wedged dedupe key is still marked in Redis (24h TTL from the pre-fix run). Manually clear it, or wait for TTL:

```bash
redis-cli DEL 'phase-tracker:christrudelpw:sniplink:4:address-pr-feedback'
```

New PRs are not affected — the wedge state is per-PR.

### Notice keeps re-posting on every poll

The `lastZeroTrustedState` map is monitor-scoped and non-persistent — a monitor restart *does* re-trigger a notice attempt, but the marker-grep against `gh pr view --json comments` should still prevent the duplicate post. If the marker check is failing:

1. Confirm `gh pr view <n> --repo <owner>/<repo> --json comments --jq '.comments[].body'` returns the expected marker.
2. Confirm the client's `listPrCommentBodies` isn't paginating and missing the marker on high-comment PRs (>250).

### Cluster-identity trust rule not firing for a bot comment

The rule requires `comment.author === ctx.clusterIdentity` exactly (case-sensitive). GitHub App identities have the form `<app-name>[bot]` — confirm the resolved value in the identity-resolution log line at orchestrator startup matches the observed `comment.author` from the log line in `PrFeedbackHandler.handle`.

### Handler logs `error` about identity chain but everything else works

Expected FR-007 degraded mode: association-tier trust still fires, cluster-identity match doesn't. Fix by setting `CLUSTER_GITHUB_USERNAME` in the cluster env (or ensuring `GH_USERNAME` is written by `wizard-env-writer` per #628).

### `phaseTracker.clear` warnings after every exit

Non-fatal — Redis unavailability degrades to "next monitor poll re-enqueues as duplicate until TTL". Verify the Redis client is healthy; the same issue would break other orchestrator subsystems first.
