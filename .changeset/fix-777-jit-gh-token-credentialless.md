---
"@generacy-ai/orchestrator": patch
"@generacy-ai/workflow-engine": patch
---

Fix JIT gh-token provider on wizard-bootstrapped clusters (#777).

The gh JIT token provider was gated on a `github-app` credential descriptor
that wizard-bootstrapped clusters never have, so it was always `undefined` and
every `gh` call fell back to the expired ambient `GH_TOKEN`. The provider is now
built whenever the control-plane `/git-token` path is available and fetches
credential-less (passing `credentialId` only when a descriptor exists). When a
provider is present, `GH_TOKEN` is always set on the `gh` subprocess (never
`undefined`), so it can no longer inherit the stale ambient token.
