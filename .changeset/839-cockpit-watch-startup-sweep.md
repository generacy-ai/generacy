---
"@generacy-ai/generacy": patch
---

Emit initial actionable-state lines on `generacy cockpit watch` startup (#839).

The watch loop's first poll was a silent baseline — it recorded the current
snapshot and emitted nothing, so any issue already sitting in an actionable state
(`waiting-for:*`, `completed:validate`, `failed:*`, `needs:intervention`,
`agent:error`, or a PR with failing checks) at the moment the watch started was
never surfaced. A developer running the documented queue → watch order would start
a watcher that stayed silent about every gate already waiting on them. The first
poll now runs a startup sweep that emits one NDJSON line per actionable snapshot,
each marked `initial: true`; non-actionable snapshots stay silent at baseline, and
polls 2..N keep the existing baseline-on-absent-key behavior. Actionability is
computed from raw `Snapshot.labels[]` rather than the classifier's tier-collapsed
`state`, so an issue carrying both a `completed:*` and a `waiting-for:*` label is
still surfaced. `initial` lines need no consumer-side dedupe — the plugin is
stateless per line — so re-surfacing pending items on a watch restart is by design.
