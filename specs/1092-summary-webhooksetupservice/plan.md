# Implementation Plan: Widen `WebhookSetupService` locked event set and heal stale hooks

**Feature**: Widen the `LOCKED_EVENTS` set on Generacy-managed GitHub webhooks to include `pull_request_review`, `pull_request_review_comment`, `issue_comment`, and heal stale hooks in place on orchestrator boot so PR-review feedback and clarification-answer comments arrive over the smee channel instead of waiting for the (adaptively widened) poll interval.
**Branch**: `1092-summary-webhooksetupservice`
**Status**: Complete

## Summary

Three narrow, additive fixes to `packages/orchestrator/src/services/webhook-setup-service.ts`:

1. **FR-001** — `LOCKED_EVENTS` grows from 4 → 7 entries. `pull_request_review`, `pull_request_review_comment`, `issue_comment` are added to match the smee-receiver's per-event dispatch table exactly. `pull_request_review_thread` is explicitly deferred (no consumer).
2. **FR-002 + FR-003 + FR-004** — `_ensureWebhookForRepo`'s `skip-active` branch (row 4 of the #972 decision matrix) is extended: when `missingEvents = LOCKED_EVENTS.filter(e => !hook.events.includes(e))` is non-empty, PATCH the hook via the existing `_updateRepoWebhook(owner, repo, id, { events: [...new Set([...hook.events, ...LOCKED_EVENTS])] })` helper, count it as `WebhookSetupSummary.reactivated++`, return `action: 'reactivated'`, and replace the current `logger.warn(..., 'Existing webhook has event mismatch - events not updated')` line with a single `logger.info(..., 'Existing webhook was missing events — patched')` carrying `{owner, repo, webhookId, missingEvents, newEvents}`.
3. **FR-005** — `_ensureWebhookForRepo`'s `reactivate` branch (row 5, inactive hook whose URL matches) merges the full `LOCKED_EVENTS` set instead of only `'issues'`, so a reactivated hook is not born already stale.

Consumer side (`smee-receiver.ts`, `PrFeedbackMonitorService`, `ClarificationAnswerMonitorService`, `/webhooks/pr`, `adaptive-poll-controller.ts`) is untouched — the fix is producer-side only (FR-009 / FR-010).

## Technical Context

- **Language / runtime**: TypeScript, Node ≥22, ESM.
- **Package**: `@generacy-ai/orchestrator` (`packages/orchestrator`).
- **File under fix**: `packages/orchestrator/src/services/webhook-setup-service.ts` (single file; no new module).
- **Test files touched**: `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts` (existing suite; add new heal-on-skip-active branch, update reactivate-events assertions, add SC-001/003/004 pins) and `packages/orchestrator/src/services/__tests__/smee-receiver-987.test.ts` (extend for SC-005 — `pull_request_review` / `issue_comment` dispatch already covered in tests 6/8; add explicit `pull_request_review_comment.created` if not already there, verify all three families).
- **Deps**: `@generacy-ai/workflow-engine` (`executeCommand`), `@generacy-ai/control-plane` (`JitTokenError`) — both already imported. `vitest` for tests. Zero new deps.
- **GitHub API**: `PATCH /repos/{owner}/{repo}/hooks/{hook_id}` accepts a full `events` array replacement (documented — Assumption 1). Invoked via existing `_updateRepoWebhook` helper (which uses `gh api -X PATCH ... -F events[]=<name>` for each event).
- **DI**: No new DI seams. Existing `WebhookSetupServiceOptions` shape unchanged.
- **Public API**: `WebhookSetupResult.action` union unchanged (per Q1=A). `WebhookSetupSummary` shape unchanged. `LOCKED_EVENTS` is `const` and not exported — widening it is not a public API change.
- **Persistence surfaces**: none added (SC-006).

## Project Structure

```
packages/orchestrator/src/services/
├── webhook-setup-service.ts                      # MODIFIED — 4 targeted edits (see below)
└── __tests__/
    ├── webhook-setup-service.test.ts             # MODIFIED — heal-on-skip-active added; reactivate assertions updated; SC-001/003/004 pins added
    └── smee-receiver-987.test.ts                 # MODIFIED (minor) — add pull_request_review_comment.created if not already covered (test 7 already covers it)

specs/1092-summary-webhooksetupservice/
├── spec.md                                       # (existing) source of truth for FRs / SCs
├── clarifications.md                             # (existing) Q1–Q4 answers cited throughout plan
├── plan.md                                       # THIS FILE
├── research.md                                   # NEW — decisions & alternatives
├── data-model.md                                 # NEW — types + validation invariants
├── contracts/
│   └── heal-events-branch.md                     # NEW — heal-on-skip-active shape + reactivate full-set merge
└── quickstart.md                                 # NEW — reviewer / operator smoke instructions
```

### Edit locations — `webhook-setup-service.ts`

| # | Line(s) today | Change |
|---|---|---|
| 1 | `114` — `const LOCKED_EVENTS = ['issues', 'pull_request', 'check_run', 'check_suite'] as const;` | Add `'pull_request_review'`, `'pull_request_review_comment'`, `'issue_comment'`. Final tuple length 7. (FR-001) |
| 2 | `391–411` — `skip-active` branch, warn-only mismatch log | On `missingEvents.length > 0`: build `newEvents = [...new Set([...hook.events, ...LOCKED_EVENTS])]`, call `_updateRepoWebhook(owner, repo, hook.id, { events: newEvents })` inside try/catch (routed through `_handleGhFailure(..., 'patch', ...)` on error), emit single `logger.info({owner, repo, webhookId, missingEvents, newEvents}, 'Existing webhook was missing events — patched')`, return `{owner, repo, action: 'reactivated', webhookId: hook.id}`. Preserve the existing `logger.info(..., 'Webhook already exists and is active')` **only** on the `missingEvents.length === 0` steady-state path. (FR-002 + FR-003 + FR-004 + FR-008 idempotency) |
| 3 | `415` — `const mergedEvents = [...new Set([...hook.events, 'issues'])];` | Replace `'issues'` with `...LOCKED_EVENTS`. Result: `[...new Set([...hook.events, ...LOCKED_EVENTS])]`. (FR-005) |
| 4 | `86` — `WebhookSetupResult.action` doc comment | Extend `reactivated` bullet to name the event-heal case ("… persisted-URL match PATCHed, or event-set healed on active hook"). (FR-003 discoverability rider) |

### Edit locations — `webhook-setup-service.test.ts`

| Test | Line today | Change |
|---|---|---|
| "should warn when active webhook has event mismatch" | `438–473` | Rewrite: (a) mock now returns TWO `executeCommand` results — list, then PATCH — instead of one; (b) assert `result.reactivated === 1` (was `.skipped === 1`); (c) assert `result.skipped === 0`; (d) assert PATCH call was issued with `events` containing all 7 `LOCKED_EVENTS`; (e) assert `mockLogger.info` (not `.warn`) was called with `'Existing webhook was missing events — patched'` and payload `{missingEvents: [...], newEvents: [...]}`; (f) drop the stale `expectedEvents: ['issues']` assertion. Rename to "should heal active webhook when events subset of LOCKED_EVENTS". (FR-002/003/004) |
| "should reactivate inactive webhooks and merge events" | `386–436` | Update `events` assertion at line 432: `['push', 'issues']` → `['push', 'issues', 'pull_request', 'check_run', 'check_suite', 'pull_request_review', 'pull_request_review_comment', 'issue_comment']` (or use `expect.arrayContaining([...LOCKED_EVENTS_ARRAY])` for order-independence). (FR-005) |
| "should reactivate inactive webhook without changing events when issues already included" | `907–955` | Update expected `events` payload: prior events + all `LOCKED_EVENTS` deduped. (FR-005) |
| "should reactivate inactive webhook and add issues event when missing" | `957–995` | Update expected `events` payload: prior events ∪ all 7 `LOCKED_EVENTS`. Rename subject line to drop "issues" specificity. (FR-005) |
| "should reactivate inactive webhook with empty events array" | `997–1032` | Update expected `events` to `LOCKED_EVENTS` (all 7). (FR-005) |
| Any other test asserting `events: ['issues']` or `events: ['push', 'issues']` on the reactivate branch | grep first | Update to LOCKED_EVENTS union. (FR-005) |
| **NEW** "SC-001: newly-created webhooks carry the full 7-event LOCKED_EVENTS set" | append to `describe('ensureWebhooks — create branch', ...)` | Assert `POST /repos/.../hooks` argv includes `-F events[]=<x>` for each of the 7 events. (FR-006 + SC-001) |
| **NEW** "SC-003: idempotent — active hook already matching LOCKED_EVENTS is not PATCHed" | append to skip-active describe | Seed a mock hook with `active: true, events: [...LOCKED_EVENTS]`; assert `executeCommand` called exactly once (list only, no PATCH), `result.skipped === 1`, `result.reactivated === 0`. (FR-008 + SC-003) |
| **NEW** "SC-004: reactivated inactive hook receives full LOCKED_EVENTS union" | already partially covered by FR-005 updates above; add one dedicated assertion that PATCH argv contains all 7 event names. (SC-004) |

### Edit locations — `smee-receiver-987.test.ts`

- Tests 6 (`pull_request_review.submitted`) and 8 (`issue_comment.created`) at lines 219, 272 already cover the SC-005 assertion for two of the three new event families. Test 7 at line 249 already covers `pull_request_review_comment.created`. **Nothing to add** unless review discovers a missing branch (e.g., dedicated `expect(receiver).toDispatch(...)` for each). Adding a comment block near tests 6–8 citing `#1092 SC-005` is optional and cheap.

## Constitution Check

- `.specify/memory/constitution.md` does not exist (only `.specify/templates/`). No constitutional gates apply. (Cross-checked at plan time.)
- CLAUDE.md gates that DO apply:
  - **Changeset gate**: This PR modifies `packages/orchestrator/src/webhook-setup-service.ts` (non-test file under `packages/*/src/`) → CI will fail without a new `.changeset/*.md`. Add `.changeset/1092-widen-locked-events.md` — `@generacy-ai/orchestrator` **patch** (behavior fix, no new public exports; `WebhookSetupResult.action` union unchanged per Q1=A). Confirm at implement time.
  - **Doorbell smee source**: Assumption 6 verified — `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts` consumes only `issues.closed` and `pull_request.closed`, both already in `LOCKED_EVENTS`. No cross-package change needed.
  - **No new persistence surfaces (SC-006)**: verified by construction — no new files under `/var/lib/generacy/`, no new Redis keys, no new env vars, no new orchestrator routes.

## Composition with sibling systems

- **#953 (adaptive-poll-controller)**: orthogonal and out of scope (FR-010). Once FR-001 ships, review-event families arrive on the smee channel and `recordWebhookEvent()` fires with the right event type, so the "webhook healthy → widen poll" behavior becomes semantically correct for `PrFeedbackMonitorService` and `ClarificationAnswerMonitorService`. #953's dead-flag hazard is independent and does not block this fix.
- **#972 decision matrix** (`specs/972-summary-snappoll-preview/contracts/ensure-webhooks-behavior.md`): the heal-on-skip-active behavior is a strict extension of row 4. Row 4's contract text ("if hook's `events` array is missing any of the four locked events, warn about the event mismatch — do NOT PATCH") is superseded for the 7-event set. Contract update lives in this spec's `contracts/heal-events-branch.md` (does not modify the #972 contract file, which is a frozen artifact on that branch).
- **#987 (smee-receiver dispatch)**: unchanged. Receiver has correctly dispatched all three new event families since #987; the producer-side stale subscription is the only broken link.
- **#1005 (adopt/take-over)**: unchanged. `findExistingSmeeChannel` and the `staleGeneracySmee` take-over branch at `webhook-setup-service.ts:565–579` still fire before the heal branch's `missingEvents` check — order preserved.

## Post-Command Check

Per the /plan workflow, next step is `/speckit:tasks` to generate the task list from this plan.
