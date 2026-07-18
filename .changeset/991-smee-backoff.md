---
"@generacy-ai/smee-backoff": minor
"@generacy-ai/orchestrator": minor
"@generacy-ai/generacy": minor
---

Cap smee.io SSE reconnect backoff at 30s (was 5min) and add equal jitter, sharing
the algorithm via a new `@generacy-ai/smee-backoff` package. Reduces real-time
recovery latency for the orchestrator webhook receiver and the cockpit doorbell
after a transient smee.io outage.
