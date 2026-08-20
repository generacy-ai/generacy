---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
---

CI-aware merge readiness — skipped≠passed + post-validate approval gate (#1133).

The worker previously treated a PR as merge-ready the moment the `validate`
phase succeeded. Repo `ci.yml`s skip draft PRs, and a `skipped`/`neutral` run
reads as SUCCESS in naive rollups, so a PR whose CI never executed could sail
through the final gate.

Fix (behind the new independent `ciMergeGateEnabled` flag, default off →
byte-identical to today when disabled):

- `@generacy-ai/workflow-engine`: new public `GitHubClient.getCiRunsForSha`
  client method (primary `commits/{sha}/check-runs` readout, `actions/runs`
  fallback filtered to the head SHA, both normalized to `CiRun`), a pure
  `aggregateCiVerdict(runs)` three-state verdict (`green` | `pending` |
  `not-passed`) that drops `skipped`/`neutral` and requires ≥1 concrete
  `success` with no failures to be green, and the new `waiting-for:ci` /
  `completed:ci` label vocabulary.
- `@generacy-ai/orchestrator`: folds a bounded exponential-backoff CI wait
  into `validate` completion (never busy-loops, pauses with `waiting-for:ci` +
  `agent:paused` on timeout), relocates the `implementation-review` gate to
  fire on `validate` via the new `on-ci-green` condition once CI is confirmed
  green, and threads `ciMergeGateEnabled` / `ciWaitTimeoutMs` from env through
  config, resolver, and phase-loop.
