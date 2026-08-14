---
"@generacy-ai/orchestrator": patch
---

Widen `WebhookSetupService.LOCKED_EVENTS` from 4 to 7 entries (adds `pull_request_review`, `pull_request_review_comment`, `issue_comment`) so PR-review feedback and clarification-answer comments arrive over the smee channel instead of waiting for the (adaptively widened) poll interval (FR-001). Heal existing active Generacy webhooks on orchestrator boot: when a hook's events are a strict subset of `LOCKED_EVENTS`, PATCH the hook to include the missing events, count as `reactivated`, emit `info: Existing webhook was missing events — patched` in place of the pre-fix warn line (FR-002 / FR-003 / FR-004). Reactivate branch now merges the full `LOCKED_EVENTS` set instead of only `'issues'` so reactivated hooks are not born already stale (FR-005). Public API (`WebhookSetupResult.action` union, `WebhookSetupSummary` shape) unchanged. Fixes #1092.
