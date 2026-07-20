---
"@generacy-ai/orchestrator": patch
---

Adopt existing smee channel on cluster delete→relaunch (#1005).

`SmeeChannelResolver` gains a new `adopted` tier between `persisted` and
`provisioned`. When the persisted channel file is missing (e.g. after a
cluster destroy), the resolver calls an injected discovery callback that
scans configured repos' GitHub webhooks and reuses any existing Generacy
smee channel URL — persisting it so the next boot short-circuits at the
`persisted` tier. `WebhookSetupService._selectExistingHookForUpdate` gains
a single-hook take-over branch: exactly one stale Generacy smee hook (URL
neither current nor persisted) is `update-url`-repointed to the current
channel; zero and ≥2 preserve today's `create` / `foreign` behavior to
avoid duplicate delivery.

Internal observability + wiring change only — no public API surface change.
