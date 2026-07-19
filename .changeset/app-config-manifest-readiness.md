---
"@generacy-ai/control-plane": patch
---

Disambiguate "workspace still cloning" from "cloned, no appConfig declared" in the app-config manifest endpoint.

`GET /control-plane/app-config/manifest` previously returned `null` for both
states, so the cloud bootstrap UI couldn't tell them apart and had to poll a
fixed 300s window before falling back to the empty state. The handler now keys
readiness on the presence of a `.generacy/cluster.yaml` (or `cluster.local.yaml`)
at the resolved dir: it returns `null` only while the workspace repo hasn't been
cloned yet, and a non-null empty manifest (`{schemaVersion:'1',env:[],files:[]}`)
once it's cloned but declares no `appConfig`. The UI can now advance the instant
the clone lands instead of waiting out the poll window.
