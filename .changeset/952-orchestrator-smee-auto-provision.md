---
"@generacy-ai/orchestrator": minor
---

Auto-provision a smee.io channel on orchestrator startup when none is
configured, persist it to `/var/lib/generacy/smee-channel` (mode 0600), and
let the existing webhook-setup flow wire the GitHub webhook. Every automated
provisioning path (local CLI, cloud onboarding, cloud deploy) previously
shipped an empty `SMEE_CHANNEL_URL`, so every new cluster silently ran
webhook-less and degraded to polling. The orchestrator's new
`SmeeChannelResolver` runs asynchronously off the listen path (fire-and-forget)
with a 4-tier precedence — env/yaml → persisted file → `POST https://smee.io/new`
(5 s timeout, 2 attempts, 1 s delay) → persist — and fails open on any tier.
Clusters with a hand-set env URL are unchanged.
