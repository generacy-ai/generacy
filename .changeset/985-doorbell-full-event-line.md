---
"@generacy-ai/generacy": minor
---

`cockpit doorbell` now emits each event as a full NDJSON line instead of the bare
event-type discriminator (#985). The wire shape mirrors `cockpit watch` and
carries `{ type, repo, kind, number, event, to, labels, url, … }` at minimum, so
`/cockpit:auto` can dispatch without re-querying GitHub per wake — removing the
~5000 pts/hr GraphQL rate-limit amplifier. The smee path also populates `to`
locally via `classifyIssue` (zero added `gh` calls) and stamps an optional
`checks: 'green' | 'red'` verdict on `pr-checks` / `completed:validate` events
using the periodic poll's cached `PrSnapshot.checksRollup`.
