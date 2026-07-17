---
"@generacy-ai/orchestrator": minor
"@generacy-ai/generacy": minor
---

Wire the smee doorbell end-to-end for operator sessions on smee-live clusters.

The orchestrator's `SmeeChannelResolver` now mirrors the resolved channel URL
to a shared workspace path so operator devcontainer/tunnel sessions — which
do not mount the cluster-internal `generacy-data` volume — can discover it,
and the doorbell's startup `gh` calls survive transient failures via a two-
tier retry envelope instead of `exit(2)`-ing on the first hiccup.
