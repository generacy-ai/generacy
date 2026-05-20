---
"@generacy-ai/orchestrator": patch
---

Fix workspace:^ dependency leak in published package. Add prepublishOnly guardrail to all publishable packages to prevent future publishes with unresolved workspace: protocol specifiers.
