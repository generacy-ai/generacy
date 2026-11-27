---
"@generacy-ai/orchestrator": patch
---

Treat a missing clarifications.md (spec dir present) as "no pending questions" so a zero-question clarify phase advances to plan instead of stranding at waiting-for:clarification. Non-ENOENT read errors, missing spec dirs, and unparseable files still fail closed.
