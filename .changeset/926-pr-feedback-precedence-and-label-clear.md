---
"@generacy-ai/cockpit": patch
"@generacy-ai/orchestrator": patch
---

Fix two pr-feedback defects surfaced during cockpit v1 (#926).

- `@generacy-ai/cockpit`: `waiting-for:address-pr-feedback` now outranks every
  other `waiting-for:*` gate in the classifier precedence order — an
  actively-rewriting-code state is more specific than any passive gate it can
  coexist with, so a PR mid-feedback no longer classifies as the coexisting
  passive gate.
- `@generacy-ai/orchestrator`: the pr-feedback handler now clears
  `agent:in-progress` at a single shared `finally` exit path, so no terminal
  return (Cases A/B, either blocked-stuck disposition, or a thrown error) can
  leave the label pinned. The happy path coalesces the
  `waiting-for:address-pr-feedback` + `agent:in-progress` removal into one
  `removeLabels` call so cockpit/auto observers never see one label without the
  other; the `finally` clear is an idempotent backstop and stays non-fatal on
  failure.
