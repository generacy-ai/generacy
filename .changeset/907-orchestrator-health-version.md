---
"@generacy-ai/orchestrator": minor
---

Surface a real orchestrator version on `/health` so connected clusters stop reporting `v0.0.0` (#907).

The `/health` route never emitted a `version` field, so cluster-relay's metadata
collector fell back to the literal `"0.0.0"` and forwarded that to the cloud
dashboard for every cluster. A new `resolveOrchestratorVersion()` service resolves
the build identifier from `ORCHESTRATOR_VERSION` (the canonical build-time env var),
falling back to the package's `package.json` version, and finally to the sentinel
`"unknown"` — with the literal `"0.0.0"` treated as "no real version" from either
source so a stray env var or workspace-default cannot reproduce the symptom. The
handler now emits `version`, and it is declared on both the Fastify response schema
and the Zod `HealthResponseSchema` (required `z.string()`) so Fastify no longer
strips it on serialization.
