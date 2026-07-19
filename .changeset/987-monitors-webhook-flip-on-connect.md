---
"@generacy-ai/orchestrator": patch
---

Flip monitors to webhook mode after smee receiver connects (#987). On the
auto-provisioned / persisted smee-channel path, the label / PR-feedback /
merge-conflict / clarification-answer monitors were stuck at fast adaptive
poll cadence with `reason=webhooks-not-configured` because `webhooksConfigured`
was frozen at construction time from the static `config.smee.channelUrl`.
`startSmeePipeline` now calls a one-way runtime setter on all four monitors
once the smee receiver reports Connected, and the receiver fans out
`recordWebhookEvent()` to all four monitors on every parsed inbound event so
the controller's `webhook-stale → to-fast` safety net remains reachable.
