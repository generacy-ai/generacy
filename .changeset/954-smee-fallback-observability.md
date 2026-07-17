---
"@generacy-ai/orchestrator": patch
---

Surface smee-less startup and webhook-setup opt-out (#954).

When no smee channel is configured, the orchestrator silently degrades to polling:
the smee receiver is constructed inside `if (config.smee.channelUrl)` with no
`else`, so `docker logs … | grep -i smee` returns nothing on a polling-only
cluster. This adds three observability primitives:

- A `warn` at label-monitor construction when `config.smee.channelUrl` is unset
  in full mode with an active label monitor and repositories configured. Payload
  states the effective `pollIntervalMs`, `completedCheckInterval = 3` (from
  `LabelMonitorService`), both computed `process:*`/`completed:*` worst-case
  latencies, and remediation pointers (`SMEE_CHANNEL_URL`,
  `orchestrator.smeeChannelUrl`). The block guards on `!isWorkerMode &&
  config.labelMonitor && config.repositories.length > 0` — no false-warning in
  worker mode, pre-activation, or deliberate opt-out.
- An `info` at the webhook-setup guard when `config.smee.channelUrl` IS set but
  `config.webhookSetup.enabled` is false, so an operator inheriting an opt-out
  config gets one observable line rather than silence. `info`, not `warn`:
  deliberate opt-out is not degradation.
- An additive optional `smeeConfigured: boolean` field on `HealthResponse`
  (200 + 503 schemas), populated from `!!config.smee.channelUrl` at
  `createServer()` construction. Present on all processes — it's a
  configuration statement, not a degradation claim.
