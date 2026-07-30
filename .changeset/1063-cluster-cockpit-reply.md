---
'@generacy-ai/cluster-relay': minor
---

Add `cluster.cockpit.reply` member to `RelayMessageSchema` so cloud-sent gate
acknowledgements stop appearing as `Invalid relay message, skipping` warns.
Observability-only; correlation deferred to #1059 steps 4–7.
