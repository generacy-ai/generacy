---
"@generacy-ai/orchestrator": patch
---

Fail loud on webhook-registration 403 in `WebhookSetupService` (#972).

When `ensureWebhooks()` gets HTTP 403 (`Resource not accessible by integration`) on
list/create/update — the systemic missing `admin:repo_hook` scope on the Generacy
GitHub App — the orchestrator now emits a triple: a structured `warn` log line,
a `cluster.bootstrap` relay event `{ status: 'failed', reason:
'webhook-registration-forbidden', repo, installationId, missingScope:
'admin:repo_hook' }`, and a cluster status transition to `degraded` (via
`POST /internal/status`). Also locks the create-time event set to `issues`,
`pull_request`, `check_run`, `check_suite` (FR-001) and adds an exact
persisted-URL heal path (FR-004) that PATCHes a hook whose `config.url` matches
a previously-provisioned smee channel to the current channel URL, and refuses
to modify foreign smee hooks that match neither current nor persisted URL.
