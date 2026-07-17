---
"@generacy-ai/cockpit": minor
"@generacy-ai/generacy": patch
---

Reduce cockpit's GraphQL point spend during `/cockpit:auto` runs so a single
shared-token operator doesn't exhaust GitHub's 5k/hr GraphQL bucket. Five
coordinated fixes at the cockpit CLI + `GhCliWrapper` layer:

- New `GhResponseCache` — 20s TTL read-through cache with in-flight coalescing
  wired into the four hot-path GraphQL methods (`getPullRequestCheckRuns`,
  `getIssue`, `resolveIssueToPR`, `getPullRequest`). Opt-in via
  `new GhCliWrapper(runner, logger, { cache })`.
- New `RateLimitScheduler` — probes `gh api rate_limit` and widens the poll
  interval on a hysteresis ladder (`< 20% → 2× base`, `< 5% → 4× base`,
  ceiling `5 min`). Honours `retry-after` when present.
- New `derivePrChecksNeeded()` gate on `runOnePoll` — skips
  `getPullRequestCheckRuns` for terminal-green PRs until head-SHA changes,
  labels change, or a 20-cycle safety re-fetch fires.
- `resolveEpic` is now refreshed only every 10th cycle in both the CLI watch
  loop and the MCP event-bus loop (was every cycle).
- `PauseState.skipNextCycle` prevents the immediate-post-catch-up double poll
  after a paused event bus resumes.

New public exports on `@generacy-ai/cockpit`: `createGhResponseCache`,
`GhCacheOptions`, `GhResponseCache`, `createRateLimitScheduler`,
`RateLimitSchedulerOptions`, `RateLimitScheduler`, `RateLimitProbeResult`,
`GhCliWrapperOptions`, plus a new optional `headRefOid?: string` field on
`PullRequestSummary`. Bare `new GhCliWrapper(runner)` retains pre-#970
behavior exactly.
