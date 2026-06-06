---
"@generacy-ai/control-plane": minor
"@generacy-ai/orchestrator": minor
---

feat: route gh-CLI GitHub API calls through the JIT token provider (#773)

Completes the JIT credential migration: the gh-CLI GitHub API path no longer
relies on the static wizard `GH_TOKEN`, which expired after ~1h and caused
workers and the orchestrator to 401 mid-run. The orchestrator now mints
short-lived installation tokens on demand via the JIT GitHub token provider
(`jit-github-token-provider`), with the wizard-creds provider retained as a
fallback, and the control-plane git-credential helper resolves tokens through
the shared `jit-git-token-client`.
