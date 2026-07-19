---
"@generacy-ai/generacy": patch
---

Add a `webhook-config` stage to the `/cockpit:auto` doorbell channel discovery that reads the smee.io URL directly from the registered repo webhook via `gh api /repos/{owner}/{repo}/hooks`, removing the `COCKPIT_DOORBELL_SMEE_URL` workaround for operator sessions that do not share the cluster's filesystem.
