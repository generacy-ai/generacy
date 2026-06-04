---
"@generacy-ai/orchestrator": minor
---

feat(orchestrator): detect cluster identity split and emit relay event (#750)

Adds an identity-split detector that compares `process.env.GENERACY_CLUSTER_ID`
against the persisted `cluster.json.cluster_id` during server startup. On
mismatch it emits a single `cluster.identity-split` relay event per orchestrator
process lifetime — surfacing clusters whose injected env identity has diverged
from their persisted identity.

The detector is best-effort and non-fatal: it never mutates env, `.env`, or
`cluster.json`, and drops the event if no relay client is available. The new
`cluster.identity-split` channel is added to the internal relay-events allowlist,
and detection runs on both the existing-key and wizard-mode activation paths.
