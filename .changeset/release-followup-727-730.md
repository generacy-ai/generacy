---
"@generacy-ai/activation-client": minor
"@generacy-ai/orchestrator": patch
"@generacy-ai/generacy": patch
---

Catch stable up after #727 (cluster-side `tier-limit-exceeded` handling per
[generacy-cloud#700](https://github.com/generacy-ai/generacy-cloud/issues/700))
and #730 (empty-tier formatter fix per #728) shipped without their own
changesets. The latter should have been caught by the new gate from #729, but
slipped through because the PR branch predated the gate's merge by minutes and
was never rebased — the workflow YAML resolved from the PR's HEAD (old/permissive
version) rather than from develop's HEAD (new/strict version).

Per-package summary:

- `@generacy-ai/activation-client` — **minor** (additive public-API surface):
  new `tier-limit-exceeded` variant on `PollResponseSchema` carrying
  `{ cap, requested, tier }`; new exported `formatTierLimitError` function
  shared between the resolver-side gate and the poll-time reject; empty-tier
  formatter rendering fixed.
- `@generacy-ai/orchestrator` — **patch**: new `TIER_LIMIT_EXCEEDED`
  `ActivationError` code; activation flow throws on the new poll variant
  with the formatted message.
- `@generacy-ai/generacy` — **patch**: deploy command's activation poll
  branches on the new variant; `worker-count-resolver` refactored to use
  the shared `formatTierLimitError` instead of an inline string (closes
  the wording-drift between resolver-side and poll-time error messages).
