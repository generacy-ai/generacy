---
"@generacy-ai/control-plane": minor
---

feat(control-plane): drive GH_USERNAME/GH_EMAIL from the credential's acting account (#760)

`mapCredentialToEnvEntries` now emits `GH_USERNAME`/`GH_EMAIL` from the
github-app credential's new `gitIdentityLogin` field (the operator-selected
acting account) when present, falling back to `accountLogin` for credentials
sealed before the field existed. This fixes commit mis-attribution and silent
label-monitor drops on org-owned repos, where `accountLogin` is the org name
rather than a person, without requiring a `CLUSTER_GITHUB_USERNAME` override.
