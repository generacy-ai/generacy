---
"@generacy-ai/workflow-engine": patch
"@generacy-ai/orchestrator": patch
---

Trust the cluster's own identity in the PR-feedback loop so cockpit request-changes feedback can be auto-addressed (#869).

The #842 author-trust filter and the cockpit's request-changes path were mutually
deadlocked: feedback the cockpit posts through its own human-gated gate is authored
by the cluster's GitHub identity, which GitHub reports as `author_association: NONE`,
so the handler classified its own first-party payload as untrusted and discarded it.
The trust predicate now treats the resolved cluster identity as trusted in addition
to `OWNER`/`MEMBER`/`COLLABORATOR`, and both the monitor and the handler evaluate the
same shared predicate. A zero-trusted exit (unresolved threads present but none
trusted) no longer removes the label, log "No unresolved threads found", or exit
silently — it retains state, logs at `warn` with the skipped authors/reasons, and the
enqueue-dedupe state is settled so a later trusted comment re-triggers the loop.
