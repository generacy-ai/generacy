---
"@generacy-ai/control-plane": minor
---

feat: cluster-side JIT git credential helper (#766)

Add a git `credential.helper` that fetches a fresh GitHub installation token on
each git operation instead of caching the static `GH_TOKEN`. The control-plane
gains a `git-token` route plus `git-token-manager`, `cloud-pull-client`, and
`cluster-api-key` services that obtain a token on demand from the cloud pull
endpoint (generacy-ai/generacy-cloud#817), cache it in-process, and refresh
within ~5 min of expiry. A new `git-credential-generacy` bin speaks the git
credential-helper protocol for `github.com` and degrades with a clear
`CLOUD_UNREACHABLE` error rather than a silent hang.
