---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
---

Wire the review phase's findings artifact to the PR — one COMMENT-event review per round plus draft/ready lifecycle (#1125).

`@generacy-ai/workflow-engine` gains three public `GitHubClient` methods: `createReview(owner, repo, prNumber, input)` (REST `POST /pulls/{n}/reviews`, one atomic COMMENT/APPROVE/REQUEST_CHANGES submission with inline `comments[]`), `convertPullRequestToDraft(owner, repo, prNumber)` (GraphQL node-ID resolve + idempotent `convertPullRequestToDraft` mutation, mirroring `resolveReviewThread`'s retry/auth handling), and `listPullRequestFiles(owner, repo, prNumber)` (REST `GET /pulls/{n}/files`, returns `{ filename, status, patch? }[]` for diffability checks). New wire types `ReviewEvent`, `CreateReviewComment`, `CreateReviewInput`, `PullRequestFile`.

`@generacy-ai/orchestrator` adds an internal `ReviewPoster` service that posts exactly one COMMENT review per review round (inline threads where diffable, a greppable engine marker + round number in the body, no finding dropped), dedupes re-posts by grepping existing reviews, and resolves threads for findings the artifact marks resolved on re-review rounds. `PrManager` gains an in-memory `markedReadyByEngine` flag and `convertToDraftIfEngineMarkedReady`, and the phase loop wires review-side effects (post + mark-ready-on-clean) after the review stub and draft-conversion on remediate entry. All GitHub transitions are best-effort and idempotent. The posting path is production-inert until #1124 lands the review executor — it is invoked only through the injectable `PhaseLoopDeps.readFindingsArtifact` seam, which defaults to `undefined`.
