# Clarifications — #1092 Widen `WebhookSetupService` locked event set and heal stale hooks

## Batch 1 — 2026-08-14

### Q1: Heal action name & counter shape
**Context**: FR-002 introduces a fifth outcome for `_ensureWebhookForRepo` — an existing active hook whose URL matches but whose event set is a strict subset of `LOCKED_EVENTS`. FR-003 requires that outcome be countable and grep-able in the boot log, but explicitly defers "reuse `reactivated` vs. new `healed`" to /plan (Assumption 4). The decision is load-bearing for the public shape of `WebhookSetupResult.action` and `WebhookSetupSummary`, both of which are exported from the package and asserted against in `webhook-setup-service.test.ts` (~30 `expect(result.reactivated).toBe(...)` sites). Deciding now avoids a cascading rewrite of test call-shapes at /plan.

**Question**: How should the event-heal outcome be classified in the result object, summary counter, and log-line `action` field?

**Options**:
- A: Reuse `action: 'reactivated'` + `WebhookSetupSummary.reactivated++`. No public API change; existing tests keep their `.reactivated` counter assertions. Loses grep-ability — a boot log line with `action: 'reactivated'` no longer discriminates event-heal from URL-heal from active-flag flip.
- B: Add distinct `action: 'healed'` + new `WebhookSetupSummary.healed` counter. Grep-able (`grep 'action":"healed"'` picks out exactly the event-heal case) and the summary log line at boot cleanly reports how many stale hooks were repaired. Public API widens: `WebhookSetupResult.action` union grows one member; existing consumers of the summary need to sum `reactivated + healed` for a "total-repairs" number. Requires patch to `packages/orchestrator/src/services/webhook-setup-service.ts` type exports plus test-suite updates.
- C: Reuse `WebhookSetupSummary.reactivated++` counter (no schema change) but emit the log-line `action` field as `'healed'` for grep purposes. Hybrid — preserves the summary's public shape but the boot log still discriminates. Cost: one extra branch reading `result.action` differently from the log-line `action` string is a footgun for future contributors who assume they match.

**Answer**: A — Reuse `action: 'reactivated'` + `WebhookSetupSummary.reactivated++` for the event-heal outcome. The FR-004 URL-heal already set this precedent (PATCHes an active hook, reports `reactivated`, discriminates via a distinct log message string, not a new action value). Keeps the public `WebhookSetupResult.action` union and all existing `.reactivated` test assertions intact; extend the doc comment to name the event-heal case.

---

### Q2: PATCH helper method for the heal branch
**Context**: The service already has two PATCH surfaces: `_updateRepoWebhook(owner, repo, id, {active?, events?})` (used by `reactivate`, sends events-only when URL is unchanged) and `_updateRepoWebhookConfig(owner, repo, id, {url, active, events})` (used by `update-url` heal, rewrites `config.url` + `config.content_type` + `active` + `events`). FR-002's text says "Uses the same `gh api --method PATCH ...` shape already used by the `update-url` heal branch — no new gh-cli surface required." Literal reading points at `_updateRepoWebhookConfig`, but a hook that reaches the `skip-active` branch by definition already matches `smeeChannelUrl` — so rewriting URL/content_type on every heal is redundant wire traffic and a strictly larger PATCH than necessary. Also affects the shape of the assertion the new test in FR-007 has to make on `executeCommand`'s args array.

**Question**: Which existing PATCH helper should the heal branch invoke?

**Options**:
- A: Reuse `_updateRepoWebhook(owner, repo, id, {events: [...new Set([...hook.events, ...LOCKED_EVENTS])]})` — events-only PATCH, smallest wire. `active` field omitted (hook is already `active: true` in this branch by construction). Simplest test assertion. Does NOT re-assert `content_type: json` — a hook manually set to `form` stays broken (see Q3 rider on scope).
- B: Reuse `_updateRepoWebhookConfig(owner, repo, id, {url: smeeChannelUrl, active: true, events: [...new Set([...hook.events, ...LOCKED_EVENTS])]})` — matches FR-002's "same shape as update-url heal" text literally. Rewrites URL (redundant — already matches) and `content_type=json` (accidentally beneficial if operator manually flipped to form). Larger PATCH body.
- C: Add a new helper `_updateRepoWebhookEvents(owner, repo, id, events)` — narrow purpose, clearest naming, single-responsibility. Small new gh-cli surface (contradicts FR-002's "no new gh-cli surface" phrasing, but is arguably a re-alignment of the existing surface, not a new one).

**Answer**: A — Reuse `_updateRepoWebhook(owner, repo, id, { events: [...new Set([...hook.events, ...LOCKED_EVENTS])] })`, the events-only PATCH. The heal fires in the skip-active branch where the hook is already active and URL-matched, so events is the only field that needs to change; this is the same helper the adjacent reactivate branch uses. Do not rewrite `config.url`/`content_type` (redundant) and do not add a new helper.

---

### Q3: Warn log-line behavior on heal
**Context**: The current `skip-active` mismatch branch emits `logger.warn(..., 'Existing webhook has event mismatch - events not updated')` with a stale `expectedEvents: ['issues']` field (spec FR-004). Post-fix, when the branch actively PATCHes the hook, the "not updated" phrasing becomes literally false. Two log lines (a warn + a subsequent info) would produce boot-log noise on every fresh cluster since ALL clusters shipped before this fix have stale hooks. But suppressing the warn entirely loses a signal that operators may already grep for.

**Question**: What log lines should the heal branch emit?

**Options**:
- A: Suppress the warn entirely on heal. Emit only one `logger.info(..., 'Healed webhook events')` line with `{owner, repo, webhookId, addedEvents, currentEvents, action}` fields. Boot log stays clean; no double-log noise on first-boot-post-upgrade.
- B: Keep the warn (with FR-004's `expectedEvents: LOCKED_EVENTS` correction) AND emit a follow-up info on successful PATCH. Two lines per heal; warn text amended to "Existing webhook has event mismatch — patching to add missing events". Preserves the warn signal for operators who already alert on it.
- C: Downgrade the warn to info on heal — one line, phrased as "Existing webhook was missing events — patched" with `missingEvents` and `newEvents` fields. Preserves grep discoverability without the misleading "not updated" tail.

**Answer**: C — Replace the warn with a single `logger.info` line: "Existing webhook was missing events — patched", carrying structured `{owner, repo, webhookId, missingEvents, newEvents}` fields. A successful self-heal is not a warn-level condition, and the "events not updated" text becomes false post-fix; mirrors the URL-heal's single-info precedent (oldUrl/newUrl). Also drop the stale `expectedEvents: ['issues']` field.

---

### Q4: SC-005 verification target
**Context**: SC-005 currently reads "Manual verification against a live cluster (or the integration harness at `packages/orchestrator/src/__tests__/relay-integration.integration.test.ts` if that pattern extends to smee events)." This is the only success criterion in the spec without a concrete automated test target; every other SC targets `webhook-setup-service.test.ts` or a diff-grep. The concern is whether an integration test asserting "review event → smee receiver dispatches to `PrFeedbackMonitorService`" is required for CI acceptance, or whether the unit-level assertion that `LOCKED_EVENTS` now includes those event types is sufficient (given `smee-receiver.ts` already dispatches them correctly per FR-009's "no consumer change").

**Question**: What is the CI-gate acceptance target for SC-005?

**Options**:
- A: Manual verification only. `webhook-setup-service.test.ts` proves the events are subscribed; `smee-receiver.ts` unchanged (FR-009) so dispatch is already tested; end-to-end is a smoke test the operator runs post-deploy. Ship-blocking for this PR: none.
- B: Add an integration test extending the `relay-integration.integration.test.ts` pattern to inject a synthetic `pull_request_review` webhook body into the orchestrator's `/webhooks` route and assert `PrFeedbackMonitorService` is dispatched. Highest confidence; requires extending the harness to smee events (new scope inside this PR).
- C: Add a unit test in `smee-receiver.test.ts` that a synthetic `pull_request_review.submitted` payload wired into the existing per-event dispatch table lands in the `PrFeedbackMonitorService` mock. Mid-level: proves the seam without booting the full integration harness. Requires no test-infrastructure changes.

**Answer**: C — Add unit tests in the smee-receiver suite asserting a synthetic `pull_request_review.submitted` (and `issue_comment.created`) payload dispatches to the monitor mocks — the pattern already exists in `smee-receiver-987.test.ts` tests 6–7, so extend that suite. No new integration-harness scope in this PR; end-to-end live-cluster verification remains a post-deploy smoke check, not a CI gate.
