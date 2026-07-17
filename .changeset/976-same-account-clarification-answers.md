---
"@generacy-ai/orchestrator": patch
---

Same-account plain `Q<n>:` replies on paused clarify issues now auto-resume
and integrate.

Both clarification answer surfaces (the monitor's enqueue check and the phase
loop's integration scanner) previously short-circuited any comment authored
by the cluster's own GitHub account, silently dropping human-operator answers
posted through that identity. The identity gate is removed at both sites in
favor of a broader machine-marker filter (`MACHINE_MARKERS`), delegating
same-account trust to the existing self-authored branch of the shared
trust helper. Machine-authored comments (question posts, stage/status
tracking, audit, marker-relay, bot explainers) are still excluded via the
marker set.
