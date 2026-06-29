---
"@generacy-ai/cockpit": patch
"@generacy-ai/generacy": patch
---

Fix `resolveEpicIssues` dropping cross-repo epic children (#801).

`resolveEpicIssues` now returns repo-qualified child refs (`{ repo, number }[]`)
instead of a bare `number[]`, preserving each child's repo — including cross-repo
entries declared in the manifest (`phases[].issues` / `phases[].repos` as
`owner/repo#n`). `cockpit status` and `cockpit watch` fetch and classify each
child in its own repo, and the label-graph fallback searches the configured
`cockpit.repos` for `epic-parent` references rather than only the epic's own repo.
This makes `status`/`watch --epic` work for cross-repo epics (e.g. a
`tetrad-development` epic whose children live in `generacy` and `agency`).
