# Research — #1092 Widen `WebhookSetupService` locked event set and heal stale hooks

## Decision 1 — Reuse `action: 'reactivated'` for the event-heal outcome

**Decision**: Event-heal outcome (row 4 with `missingEvents.length > 0`) reports `action: 'reactivated'` and increments `WebhookSetupSummary.reactivated`. No new counter, no new action-union member.

**Rationale**: Resolved by clarifications Q1 → A. Preserves the public `WebhookSetupResult.action` union and every existing `.reactivated` assertion in `webhook-setup-service.test.ts` (~30 sites). URL-heal (row 6) set this precedent — it PATCHes an active hook and reports `reactivated`, discriminating via the distinct log message string, not a new action value. The event-heal case follows the same pattern.

**Alternatives considered**:
- **B — New `action: 'healed'` + `WebhookSetupSummary.healed` counter**: Rejected. Widens the public `WebhookSetupResult.action` union; cascades into `~30` test-shape rewrites in `webhook-setup-service.test.ts` and any consumer of the summary needs to sum `reactivated + healed` for a "total-repairs" number.
- **C — Hybrid** (reuse `.reactivated` counter but emit `action: 'healed'` in the log field): Rejected. Creates a footgun where `result.action === 'reactivated'` but the log line says `action: 'healed'`; future contributors who assume they match will land bugs.

## Decision 2 — Use the events-only PATCH helper (`_updateRepoWebhook`)

**Decision**: Heal branch calls `_updateRepoWebhook(owner, repo, id, { events: [...new Set([...hook.events, ...LOCKED_EVENTS])] })` — events-only PATCH, no URL/content_type rewrite.

**Rationale**: Resolved by clarifications Q2 → A. The heal fires in the `skip-active` branch where the hook is by construction already active and URL-matched. Events is the only field that needs to change; rewriting `config.url` and `config.content_type` on every heal is redundant wire traffic and a strictly larger PATCH than necessary. Uses the same helper the adjacent reactivate branch already uses. No new gh-cli surface.

**Alternatives considered**:
- **B — `_updateRepoWebhookConfig(...)` (URL + content_type + active + events)**: Rejected. Matches the FR-002 spec text literally, but rewrites URL (redundant — already matches) and content_type=json (accidentally beneficial only if operator manually flipped to form — out-of-scope pull-back).
- **C — New `_updateRepoWebhookEvents(owner, repo, id, events)` helper**: Rejected. Narrower naming but contradicts FR-002's "no new gh-cli surface" guardrail and duplicates `_updateRepoWebhook`'s existing events-only behavior.

## Decision 3 — Single `info` log line on heal (drop the warn)

**Decision**: The `skip-active` branch, when `missingEvents.length > 0`, emits exactly one `logger.info(..., 'Existing webhook was missing events — patched')` with payload `{owner, repo, webhookId, missingEvents, newEvents}`. The prior `logger.warn(..., 'Existing webhook has event mismatch - events not updated')` with the stale `expectedEvents: ['issues']` field is deleted.

**Rationale**: Resolved by clarifications Q3 → C. A successful self-heal is not a warn-level condition. Keeping the warn plus adding a follow-up info would double-log noisily on every fresh-boot-post-upgrade (all clusters shipped before this fix have stale hooks). Mirrors the URL-heal's single-info precedent (`oldUrl` / `newUrl`).

**Alternatives considered**:
- **A — Suppress the warn entirely, emit only an info** (this is roughly equivalent to C but with a different message string): merged into C.
- **B — Keep the warn + info as two lines with corrected `expectedEvents: LOCKED_EVENTS`**: Rejected. Doubles log volume on first boot after upgrade for every managed repo (potentially dozens of lines) with no signal gain.

## Decision 4 — SC-005 verification: unit tests in `smee-receiver-987.test.ts`

**Decision**: SC-005 targets unit tests in `smee-receiver-987.test.ts` (already covers `pull_request_review.submitted` at test 6, `pull_request_review_comment.created` at test 7, `issue_comment.created` at test 8). No new integration-harness scope in this PR.

**Rationale**: Resolved by clarifications Q4 → C. The receiver has correctly dispatched all three families since #987. Adding an integration test would require extending `relay-integration.integration.test.ts` to inject smee payloads — significant new scope for zero-additional-confidence over the existing unit tests. Live-cluster end-to-end verification remains a post-deploy smoke check.

**Alternatives considered**:
- **A — Manual verification only**: Rejected. SC-005 needs at least a CI-catchable proof that the three new event families dispatch correctly, even if the receiver dispatch itself is FR-009 out-of-scope.
- **B — Integration test extending `relay-integration.integration.test.ts`**: Rejected. Highest confidence but new scope (test-infrastructure change to inject smee events into a running receiver). Not justified for a producer-side fix whose consumer path is already unit-tested.

## Decision 5 — Do NOT add `pull_request_review_thread`

**Decision**: `LOCKED_EVENTS` gains exactly three entries — `pull_request_review`, `pull_request_review_comment`, `issue_comment`. `pull_request_review_thread` is NOT added.

**Rationale**: Per spec Assumption 7. Nothing in `smee-receiver.ts`, `PrFeedbackMonitorService`, or the cockpit smee source consumes `pull_request_review_thread`. Adding it would be pure noise on the wire (widening smee bandwidth for no consumer). If a future thread-resolution flow needs it, add it in that PR — the producer-side subscription is trivially widened by appending to `LOCKED_EVENTS`.

## Decision 6 — Reactivate branch merges the full LOCKED_EVENTS set

**Decision**: Row 5 (`reactivate` — inactive hook, URL matches) replaces `[...new Set([...hook.events, 'issues'])]` with `[...new Set([...hook.events, ...LOCKED_EVENTS])]`.

**Rationale**: FR-005. Prevents a reactivated hook from being born already stale (missing the six locked events besides `'issues'`). Preserves any extras the hook already carries (`push`, etc.) via the `Set`-based union. Matches the semantics of the row-6 (URL heal) branch which already writes `[...LOCKED_EVENTS]` in the URL-heal PATCH.

**Impact on existing tests**: Three test cases at lines 907, 957, 997 of `webhook-setup-service.test.ts` currently assert an `events` payload of `[...priorEvents, 'issues']` after reactivate. They must update to `[...priorEvents, ...LOCKED_EVENTS]` (deduped).

## Decision 7 — Idempotency preserved by construction

**Decision**: A second `_ensureWebhookForRepo` call against a repo whose hook now matches `LOCKED_EVENTS` takes the no-op `skip-active` path with `missingEvents.length === 0`, emits only the existing `'Webhook already exists and is active'` info line, and issues no PATCH.

**Rationale**: FR-008. `missingEvents = LOCKED_EVENTS.filter(e => !hook.events.includes(e))` is a pure function of the current hook state. Once healed, subsequent boots hit the empty-array case and skip PATCH. Guarantees no boot-log noise or GitHub API churn on repeat.

**Test target (SC-003)**: Seed a mock hook with `events: [...LOCKED_EVENTS]`, run `_ensureWebhookForRepo`, assert `executeCommand` called exactly once (list only) and `result.reactivated === 0`.

## Implementation patterns

- **Existing helper reuse**: `_updateRepoWebhook(owner, repo, id, { events })` at `webhook-setup-service.ts:887–918` already accepts an optional events-only PATCH. Zero new signature. `_handleGhFailure(..., 'patch', ...)` at `:626–671` already routes 403 → fail-loud triple + relay event + degraded status, 404/500 → warn, other → generic warn. Reuse both.
- **Log-line shape**: `{owner, repo, webhookId, missingEvents, newEvents}` matches the shape of the URL-heal log line at `:460–470` (`{owner, repo, webhookId, action, oldUrl, newUrl, events}`). Consistent operator-triage format.
- **Deduplication**: `[...new Set([...a, ...b])]` is the idiom already used in the reactivate branch at `:415` and preserves the caller-supplied array order for existing entries, appending new ones. No new sort discipline.
- **Test doubles**: `executeCommandMock` from `vi.mock('@generacy-ai/workflow-engine', ...)` — the existing pattern. Mock queues one response per `executeCommand` call (list, then optional PATCH); the new heal test adds a second response entry.

## Sources / references

- `packages/orchestrator/src/services/webhook-setup-service.ts` — current implementation (post-#972, post-#1005).
- `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts` — existing test coverage (~30 `.reactivated` assertions, 4-row skip/reactivate/foreign/create matrix).
- `packages/orchestrator/src/services/smee-receiver.ts` — per-event dispatch table (already correctly dispatches all three new event families since #987).
- `packages/orchestrator/src/services/__tests__/smee-receiver-987.test.ts` — SC-005 target (tests 6/7/8 already cover the three families).
- `specs/972-summary-snappoll-preview/contracts/ensure-webhooks-behavior.md` — parent decision matrix (rows 4–11). Not modified; this fix extends row 4 semantics.
- `specs/972-summary-snappoll-preview/contracts/webhook-registration-forbidden-event.md` — 403 fail-loud triple contract (already wired via `_handleGhFailure`, no change).
- Spec `spec.md` (FR-001…FR-010, SC-001…SC-007, Assumptions 1–8), `clarifications.md` (Q1–Q4).
