---
"@generacy-ai/generacy": minor
---

Fix the cockpit CLI argument-contract drift found during the v1 integration
smoke test (#822). `cockpit status` and `cockpit watch` now take a positional
`<epic-ref>` argument matching `cockpit queue`, replacing the required
`--epic <ownerRepoIssue>` flag (pre-1.0, no compat shim). All three verbs route
their ref through `resolveIssueContext` first, so a bare issue number
(`cockpit status 1`) now resolves its `owner/repo` from the cwd git origin — the
natural `/cockpit:status <ref>` plugin invocation — alongside the existing
`owner/repo#N` and full-URL forms. Invalid refs fail loud (exit 2) with a
message enumerating every accepted form.
