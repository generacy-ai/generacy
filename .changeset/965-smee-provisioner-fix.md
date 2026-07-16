---
"@generacy-ai/orchestrator": patch
---

Fix SmeeChannelResolver.provision() to match smee.io's current GET/307 behavior; provisioning previously failed on POST/302 assumptions and every fresh cluster fell back to polling.
