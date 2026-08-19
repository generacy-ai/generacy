---
"@generacy-ai/workflow-engine": minor
"@generacy-ai/orchestrator": patch
---

Remove two false-failure paths in the #1107 phase-scoped product-diff guard (#1112).

`@generacy-ai/workflow-engine` gains a local-git `GitHubClient` method `commitExistsInCheckout(sha)` (`git rev-parse --verify --quiet <sha>^{commit}`): exit 0 → true, exit 1 (commit-missing, full or abbreviated sha) → false, any other exit → throw, so an environment fault is never mistaken for a missing commit.

`@generacy-ai/orchestrator` reworks the phase-start-ref capture/reuse block so it (a) reads through to the pre-#1110 legacy Redis key (no branch component) on a branch-scoped miss, migrating a valid value to the branch-scoped key before consuming the legacy key once, and (b) verifies a reused ref resolves in the current checkout before anchoring the diff window — re-capturing fresh HEAD when it does not. A non-commit-missing git fault still surfaces via the existing detection-failure path (`product-diff-error` + escalation). The pass/fail surface, escalation path, exclusion lists, and TTL are unchanged.
