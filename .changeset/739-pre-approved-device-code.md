---
"@generacy-ai/generacy": minor
"@generacy-ai/orchestrator": minor
---

Add pre-approved device-code activation for managed cloud clusters.

The cloud can now bake a single-use, short-TTL RFC 8628 device code into a
cluster's `.env` (`GENERACY_PRE_APPROVED_DEVICE_CODE`), threaded through the
launch/deploy/cluster scaffolders via a new optional `preApprovedDeviceCode`
config field. On first boot, the orchestrator's `activate()` redeems the
pre-approved code directly — skipping `requestDeviceCode` — and falls back to
the interactive device-code flow on terminal failure rather than crash-looping.
