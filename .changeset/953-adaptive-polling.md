---
"@generacy-ai/orchestrator": patch
---

Fix `updateAdaptivePolling()` dead branch across `LabelMonitorService`, `PrFeedbackMonitorService`, and `MergeConflictMonitorService` — the safety net is now reachable on clusters with no configured webhook feeder (#953).

The three copy-pasted `updateAdaptivePolling()` implementations all opened with `if (this.state.lastWebhookEvent === null) return`, so the fast-poll compensation only ever engaged for clusters that once had a working webhook and lost it — never for smee-less clusters (currently every new cluster). All three copies now delegate to a shared pure helper (`adaptive-poll-controller.ts`), and each service accepts a construction-time `webhooksConfigured` flag that distinguishes "webhooks configured but quiet" (grace applies) from "no webhook path exists" (engage fast interval when `adaptivePolling: true`).

Two operator-visible facts ship with this:

- **`PrMonitorConfigSchema.adaptivePolling` default flips `true → false`.** The old default was inert (dead branch); flipping it now that the branch actually fires prevents silently doubling GitHub API load on every existing cluster. Operators opt in with `PR_MONITOR_ADAPTIVE_POLLING=true`. `MonitorConfigSchema.adaptivePolling` default stays `true` — LabelMonitor's 30s base was tuned assuming a real-time path, so restoring fast polling on smee-less clusters preserves the original design intent.
- **Smee-less LabelMonitor clusters emit a `to-fast` transition log line on cycle 1** where they previously emitted nothing. The log body carries `reason: 'webhooks-not-configured'`.
