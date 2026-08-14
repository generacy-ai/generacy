# Feature Specification: Widen `WebhookSetupService` locked event set and heal stale hooks

**Branch**: `1092-summary-webhooksetupservice` | **Date**: 2026-08-14 | **Status**: Draft
**Source**: [generacy#1092](https://github.com/generacy-ai/generacy/issues/1092)

## Summary

`WebhookSetupService.LOCKED_EVENTS` at `packages/orchestrator/src/services/webhook-setup-service.ts` subscribes Generacy-created webhooks to `['issues', 'pull_request', 'check_run', 'check_suite']`. Three event types that the smee receiver's per-event dispatch actively consumes are missing from that set: `pull_request_review`, `pull_request_review_comment`, and `issue_comment`. As a result, PR review-comment / review-body findings and clarification-answer comments **never arrive over the smee channel** on any Generacy-configured cluster — they land solely via the poller in `PrFeedbackMonitorService` and `ClarificationAnswerMonitorService`.

The situation is worse than "webhook silently degrades to polling". Because `smee-receiver.ts` calls `recordWebhookEvent()` on every incoming event across all monitors on a watched repo, and `adaptive-poll-controller.ts` (`#953`) treats a recent event as "webhook healthy" and *widens* the poll interval, a healthy `issues.labeled` traffic stream on the same repo actively **slows down** detection of the event families that structurally cannot ride the same channel. Observed field impact: multi-minute delay between "operator submits `CHANGES_REQUESTED` review" and "fixer agent dispatched" — the delay is the *widened* poll interval, not the base one.

Additionally, even after the event set is corrected in code, every existing cluster keeps its stale hook forever: `_ensureWebhookForRepo`'s `skip-active` branch detects the mismatch, logs a warning, and returns. No PATCH is issued. And the `reactivate` branch (for inactive hooks matching the current URL) merges only the literal `'issues'` string into the existing events array, not the full locked set — so a reactivated hook still misses the PR-review events.

This spec covers three narrow, additive fixes to `webhook-setup-service.ts`:

1. Widen `LOCKED_EVENTS` to include `pull_request_review`, `pull_request_review_comment`, and `issue_comment`.
2. Heal existing active Generacy webhooks on boot: PATCH the hook to include any missing events from `LOCKED_EVENTS` (preserving any extras the hook already carries).
3. Reactivate branch merges the full `LOCKED_EVENTS` set, not just `'issues'`.

## Problem statement (verbatim excerpts from #1092)

**Configured events** — `packages/orchestrator/src/services/webhook-setup-service.ts`:

```ts
/** Locked event set on all Generacy-created/updated webhooks (FR-001). */
const LOCKED_EVENTS = ['issues', 'pull_request', 'check_run', 'check_suite'] as const;
```

**Consumed events** — `packages/orchestrator/src/services/smee-receiver.ts` per-event dispatch:

| Event | Consumer | In current `LOCKED_EVENTS`? |
|---|---|---|
| `issues.labeled` | `LabelMonitorService` | ✅ |
| `pull_request_review.submitted` | `PrFeedbackMonitorService` | ❌ |
| `pull_request_review_comment.created` | `PrFeedbackMonitorService` | ❌ |
| `issue_comment.created` | `ClarificationAnswerMonitorService` | ❌ |

The cockpit doorbell smee source (`packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts`) additionally consumes `issues.closed` and `pull_request.closed`, both covered by the current set.

Consequence: the `pull_request_review` / `pull_request_review_comment` dispatch paths in `smee-receiver.ts` (and the `/webhooks/pr` route) are dead code on any Generacy-configured cluster today. GitHub never sends those events to the smee channel, and PR feedback falls back to `PrFeedbackMonitorService` polling — while `adaptive-poll-controller.ts` widens that polling interval whenever a *different* event family (e.g. `issues.labeled`) arrives on the same repo.

## User Stories

### US1: PR-review feedback arrives via webhook, not polling (Priority: P1)

**As an** operator submitting a `CHANGES_REQUESTED` review on a Generacy-managed PR,
**I want** the fixer agent to be dispatched within seconds via smee,
**So that** iteration doesn't stall for the widened polling interval on every review round.

**Acceptance criteria**
- [ ] On a repo whose webhook was created by `WebhookSetupService` after this fix ships, submitting a `pull_request_review` with body text triggers `PrFeedbackMonitorService.handleWebhookEvent()` (or equivalent smee-receiver dispatch) without polling delay.
- [ ] The same holds for `pull_request_review_comment.created` (inline review-thread comments).
- [ ] The `/webhooks/pr` route in the orchestrator observes non-zero traffic in a smee-enabled cluster within one review cycle of the fix landing.

### US2: Clarification-answer comments arrive via webhook, not polling (Priority: P1)

**As an** operator posting a clarification answer as an issue comment,
**I want** `ClarificationAnswerMonitorService` to process it immediately,
**So that** the cockpit clarification gate advances within seconds, not on the next poll tick.

**Acceptance criteria**
- [ ] `issue_comment.created` on a Generacy-managed issue reaches `ClarificationAnswerMonitorService` via smee.
- [ ] The clarification-answer dispatch path is no longer polling-only for smee-enabled clusters.

### US3: Existing clusters heal their stale hook on next orchestrator boot (Priority: P1)

**As an** operator running a cluster that was provisioned before this fix,
**I want** the orchestrator to bring the existing webhook up to the current `LOCKED_EVENTS` set automatically at boot,
**So that** I don't have to manually delete and recreate the webhook (or run a one-off script) on every managed repo to unlock the new event families.

**Acceptance criteria**
- [ ] On orchestrator boot against a repo whose Generacy webhook is active and matches on URL but is subscribed to a strict subset of `LOCKED_EVENTS`, the service PATCHes the hook to include the missing events, preserving any extras the hook already carries.
- [ ] The action is counted (structured log line) as `reactivated` / `healed` rather than `skipped`.
- [ ] The stale `expectedEvents: ['issues']` context field on the mismatch log line is corrected to reference the current `LOCKED_EVENTS`.
- [ ] Idempotent: a second boot against the same repo, now with matching events, takes the `skip-active` no-op path with no PATCH.

### US4: Reactivated inactive hooks get the full event set (Priority: P1)

**As an** operator whose repo has an inactive Generacy webhook (URL still matches, `active: false`),
**I want** the reactivation on boot to bring the event set up to `LOCKED_EVENTS` in the same call,
**So that** the reactivated hook is not itself born stale.

**Acceptance criteria**
- [ ] Reactivating an inactive hook whose URL matches the current smee target results in `events` equal to the union of the hook's prior events and `LOCKED_EVENTS`.
- [ ] The prior behavior of merging only `'issues'` is removed.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `LOCKED_EVENTS` in `packages/orchestrator/src/services/webhook-setup-service.ts` MUST equal (as a set) `{'issues', 'pull_request', 'check_run', 'check_suite', 'pull_request_review', 'pull_request_review_comment', 'issue_comment'}`. | P1 | The three additions map exactly to the smee-receiver dispatch table above. `pull_request_review_thread` is explicitly deferred (nothing consumes it today — see Out of Scope). |
| FR-002 | `_ensureWebhookForRepo`'s `skip-active` branch MUST detect `missingEvents = LOCKED_EVENTS.filter(e => !hook.events.includes(e))` and, when non-empty, PATCH the hook to `events = [...new Set([...hook.events, ...LOCKED_EVENTS])]`. | P1 | Uses the same `gh api --method PATCH /repos/.../hooks/{id}` shape already used by the `update-url` heal branch — no new gh-cli surface required. |
| FR-003 | When FR-002 issues a PATCH, the outcome MUST be counted / logged as `reactivated` (or a new distinct `healed` action — deferred to /plan) rather than `skipped`, so operators can grep the boot log and see which repos got healed. | P1 | Preserves the existing counter emission pattern in the service; do not introduce a new metrics channel. |
| FR-004 | The stale warning `expectedEvents: ['issues']` context field emitted by the `skip-active` mismatch branch MUST be updated to `expectedEvents: LOCKED_EVENTS` (or removed if FR-002's PATCH makes the warning itself redundant). | P2 | Cosmetic but load-bearing for triage. |
| FR-005 | `_ensureWebhookForRepo`'s `reactivate` branch (inactive hook, URL match) MUST replace `[...new Set([...hook.events, 'issues'])]` with `[...new Set([...hook.events, ...LOCKED_EVENTS])]`. | P1 | Prevents a reactivated hook from being born already stale. |
| FR-006 | `_createRepoWebhook` and the `update-url` heal branch MUST continue to write exactly `LOCKED_EVENTS` on new hooks / URL-heal hooks — no code change needed beyond FR-001, but a regression test MUST pin the constant reference. | P2 | These branches already reference `LOCKED_EVENTS` directly; adding the three events to the constant is sufficient. |
| FR-007 | The `webhook-setup-service.test.ts` unit tests MUST be updated to assert (a) the new `LOCKED_EVENTS` membership, (b) the PATCH-on-mismatch behavior in the `skip-active` branch (both call-shape and returned action count), and (c) the reactivate branch's full-set merge. | P1 | Pins each of FR-001, FR-002, FR-003, FR-005 to a test the CI gate can catch a regression on. |
| FR-008 | The service MUST be idempotent-on-boot after healing: a second `_ensureWebhookForRepo` call against a repo whose hook now matches `LOCKED_EVENTS` takes the no-op `skip-active` path with no additional PATCH. | P1 | Boot re-entry (crash-restart, health-check, etc.) MUST NOT churn GitHub's webhook config or emit `healed` counts on repeat. |
| FR-009 | No change to `smee-receiver.ts`, `PrFeedbackMonitorService`, `ClarificationAnswerMonitorService`, `LabelMonitorService`, or the `/webhooks/pr` route. | P1 | Explicit non-goal — the consumer side is already correct; only the producer-side subscription is stale. |
| FR-010 | No change to `adaptive-poll-controller.ts`. | P1 | Explicit non-goal — once FR-001 ships, the review event families arrive as webhook events and the controller's "webhook healthy → widen poll" behavior becomes semantically correct for them. #953's dead-flag hazard is orthogonal and out of scope. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | New webhooks created by `WebhookSetupService` after the fix carry the full 7-event `LOCKED_EVENTS` set. | 100% of new hooks | Integration test: mock `gh api POST /repos/.../hooks` and assert request body `events` equals `LOCKED_EVENTS`. |
| SC-002 | Existing active Generacy webhooks with a strict subset of `LOCKED_EVENTS` are PATCHed on the next orchestrator boot. | 100% of stale hooks | Integration test: seed a mock hook with `events: ['issues', 'pull_request']`, run `_ensureWebhookForRepo`, assert PATCH issued with `events` including the three additions and any extras preserved. |
| SC-003 | Existing active Generacy webhooks that already match `LOCKED_EVENTS` are NOT PATCHed on boot (idempotency). | 0 PATCH calls | Integration test: seed a mock hook with the full 7-event set, run `_ensureWebhookForRepo`, assert no PATCH call was made and action was `skipped`. |
| SC-004 | Reactivated inactive hooks emerge with `events` ⊇ `LOCKED_EVENTS`. | 100% of reactivations | Integration test: seed a mock hook with `active: false, events: ['issues']`, run `_ensureWebhookForRepo`, assert the resulting PATCH body has `active: true` and `events` ⊇ `LOCKED_EVENTS`. |
| SC-005 | On a cluster with a freshly-healed hook, submitting a `pull_request_review` reaches the smee receiver's per-event dispatch. | Non-zero traffic on the review dispatch path within one review round of the fix landing. | Manual verification against a live cluster (or the integration harness at `packages/orchestrator/src/__tests__/relay-integration.integration.test.ts` if that pattern extends to smee events). |
| SC-006 | No new production files under `/var/lib/generacy/`; no new Redis keys; no new orchestrator env vars. | 0 net-new persistence surfaces | Code review + grep of the diff. |
| SC-007 | `webhook-setup-service.test.ts` still covers every branch (`create`, `update-url`, `skip-active`, `reactivate`, and now `skip-active + patch-events`), and the added tests fail against the pre-fix source. | Pre-fix test failure demonstrated | Reviewer runs new test file against `HEAD~1` (via `git worktree add`) and captures the failure output in the PR description. |

## Assumptions

1. GitHub's `PATCH /repos/{owner}/{repo}/hooks/{hook_id}` accepts a full `events` array replacement (documented behavior). No delta-only API is needed.
2. Existing hooks may carry event types beyond `LOCKED_EVENTS` (e.g., from prior Generacy versions or manual operator additions). The heal PATCH MUST preserve those extras — the semantics are "add missing", not "replace with exactly `LOCKED_EVENTS`". Rationale: minimum-surprise for operators who intentionally added extra subscriptions.
3. The `skip-active` branch's mismatch detection today already computes `missingEvents` (per the issue text). The fix is to *act* on the non-empty case, not to add new detection logic.
4. The `_ensureWebhookForRepo` return type / action enum already carries `reactivated` as a valid value (used by the URL-heal and reactivate branches). Whether the healed-active case reuses `reactivated` or gets a distinct `healed` value is a small choice deferred to /plan; either satisfies FR-003.
5. `webhook-setup-service.ts` runs at orchestrator boot only (idempotency assumption). No mid-flight PATCH cycle needs to be considered.
6. Cockpit smee source (`smee-source.ts`) is unaffected — it consumes `issues.closed` and `pull_request.closed` only, both already in `LOCKED_EVENTS`.
7. `pull_request_review_thread` is NOT added in this fix. Nothing in the smee-receiver, PrFeedbackMonitorService, or the cockpit path consumes it today. Adding it would be pure noise on the wire (widening the smee bandwidth for no consumer) and would count as new label vocabulary for the changeset gate. If a future thread-resolution flow needs it, add it in that PR.
8. The changeset for this PR is expected to be `@generacy-ai/orchestrator` **patch** — behavior fix, no new public exports. Confirm at /plan.

## Out of Scope

- Any change to `smee-receiver.ts` dispatch logic (already correctly consumes all four event families — the producer side is what's stale).
- Any change to `adaptive-poll-controller.ts` (#953 covers the dead-flag / smee-less hazards separately; those are orthogonal and unrelated to the missing event subscriptions).
- Any change to `PrFeedbackMonitorService` polling cadence or `ClarificationAnswerMonitorService` polling cadence — polling remains the safety net.
- Adding `pull_request_review_thread` to `LOCKED_EVENTS` — deferred (see Assumption 7).
- Retroactive migration of hooks on non-Generacy-created webhooks (URL mismatch → out of scope, service intentionally does not touch those).
- Any operator-facing CLI (`generacy webhooks sync`, etc.) to force a heal outside the boot path.
- Changes to `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts` (its event set is a strict subset of `LOCKED_EVENTS` and needs no change).

---

*Generated by speckit*
