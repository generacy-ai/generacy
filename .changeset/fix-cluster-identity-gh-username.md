---
"@generacy-ai/orchestrator": patch
---

fix(orchestrator): fall back to GH_USERNAME for cluster identity (assignee filtering)

The label-monitor resolves the cluster's GitHub identity to filter issues by
assignee. It checked `CLUSTER_GITHUB_USERNAME`, then `gh api /user`, then gave
up ("filtering disabled, all issues processed"). On cloud/wizard clusters the
credential is a GitHub App installation token (`<app>[bot]`), which can't call
`/user`, so identity resolution failed and the cluster processed every issue
instead of only those assigned to the selected account.

`resolveClusterIdentity` now falls back to `GH_USERNAME` — the human account
the installation belongs to, already delivered to the cluster by the wizard —
between the explicit config var and the `gh api /user` attempt. `CLUSTER_GITHUB_USERNAME`
still takes precedence.
