# Tasks: Widen `WebhookSetupService` locked event set and heal stale hooks

**Input**: Design documents from `/specs/1092-summary-webhooksetupservice/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/heal-events-branch.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4 all land as one unit — the constant widening and heal branch are coupled)

## Phase 1: Setup

- [X] T001 Create `.changeset/1092-widen-locked-events.md` bumping `@generacy-ai/orchestrator` **patch**. Description names FR-001 (LOCKED_EVENTS widened to 7), FR-002/003/004 (heal-on-skip-active), FR-005 (reactivate full-set merge), and states public API unchanged (Q1=A). Required by CLAUDE.md changeset gate — this PR modifies a non-test file under `packages/orchestrator/src/`.

## Phase 2: Core Implementation — `packages/orchestrator/src/services/webhook-setup-service.ts`

All four edits land in the same file and must be committed together (single behavioral fix). Order below matches plan.md § "Edit locations — webhook-setup-service.ts".

- [X] T002 [US1][US2] FR-001 — Widen `LOCKED_EVENTS` at `packages/orchestrator/src/services/webhook-setup-service.ts:114` from 4 to 7 entries by appending `'pull_request_review'`, `'pull_request_review_comment'`, `'issue_comment'`. Preserve `as const` tuple type. Do NOT add `pull_request_review_thread` (Decision 5 / Assumption 7).

- [X] T003 [US3] FR-002 + FR-003 + FR-004 + FR-008 — Rewrite the `skip-active` branch at `packages/orchestrator/src/services/webhook-setup-service.ts:391–411`:
  - Split on `missingEvents.length` (already computed).
  - When `missingEvents.length === 0`: preserve existing `logger.info(..., 'Webhook already exists and is active')` and return `{ owner, repo, action: 'skipped', webhookId: hook.id }` (row 4a — idempotency invariant V4).
  - When `missingEvents.length > 0`: build `newEvents = [...new Set([...hook.events, ...LOCKED_EVENTS])]`, call `_updateRepoWebhook(owner, repo, hook.id, { events: newEvents })` inside try/catch (route errors through `_handleGhFailure(..., 'patch', ...)`), emit exactly one `logger.info({ owner, repo, webhookId: hook.id, missingEvents, newEvents }, 'Existing webhook was missing events — patched')`, return `{ owner, repo, action: 'reactivated', webhookId: hook.id }` (row 4b — counter goes to `WebhookSetupSummary.reactivated`).
  - DELETE the pre-fix `logger.warn(..., 'Existing webhook has event mismatch - events not updated')` and its `expectedEvents: ['issues']` field entirely (per FR-004 / V6 / Decision 3).

- [X] T004 [US4] FR-005 — Replace the reactivate branch merge at `packages/orchestrator/src/services/webhook-setup-service.ts:415`: change `const mergedEvents = [...new Set([...hook.events, 'issues'])];` to `const mergedEvents = [...new Set([...hook.events, ...LOCKED_EVENTS])];`. Preserves any `hook.events` extras via the Set union (Assumption 2 / V3).

- [X] T005 FR-003 discoverability rider — Extend the `reactivated` bullet in the `WebhookSetupResult.action` union doc comment at `packages/orchestrator/src/services/webhook-setup-service.ts:86` to name the event-heal case: `'reactivated': Inactive webhook was reactivated, persisted-URL match PATCHed, OR active-hook event set healed to include missing LOCKED_EVENTS (post-#1092)`. Also extend the `WebhookSetupSummary.reactivated` field's doc comment with the same rider (data-model.md § `WebhookSetupSummary`).

## Phase 3: Tests — `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts`

Update existing branch tests to reflect the widened constant + heal semantics, and add three new tests pinning SC-001, SC-003, SC-004. All tests in a single file — parallelization within the file is not meaningful (vitest runs suites serially inside a file).

- [X] T006 [US3] Rewrite existing test at `webhook-setup-service.test.ts:438–473` (currently `"should warn when active webhook has event mismatch"`) into `"should heal active webhook when events subset of LOCKED_EVENTS"`:
  - Queue TWO `executeCommand` mock responses (list, then PATCH), not one.
  - Assert `result.reactivated === 1` (was `.skipped === 1`); `result.skipped === 0`.
  - Assert the second `executeCommand` call was the PATCH with argv containing `-F events[]=<name>` for each of the 7 `LOCKED_EVENTS`.
  - Assert `mockLogger.info` was called with `'Existing webhook was missing events — patched'` and payload `{ missingEvents: [...], newEvents: [...] }`.
  - Assert `mockLogger.warn` was NOT called with the old `'events not updated'` message.
  - Drop the stale `expectedEvents: ['issues']` field assertion.

- [X] T007 [US4] Update the four reactivate-branch tests to assert the full-set merge (FR-005 / V3):
  - `webhook-setup-service.test.ts:386–436` (`"should reactivate inactive webhooks and merge events"`) — update the expected `events` payload at ~line 432 from `['push', 'issues']` to the union of `['push']` + all 7 `LOCKED_EVENTS` (deduped). Prefer `expect.arrayContaining([...LOCKED_EVENTS])` for order-tolerance.
  - `webhook-setup-service.test.ts:907–955` (`"should reactivate inactive webhook without changing events when issues already included"`) — update expected `events` payload to prior events ∪ all 7 `LOCKED_EVENTS`.
  - `webhook-setup-service.test.ts:957–995` (`"should reactivate inactive webhook and add issues event when missing"`) — update expected `events` payload to prior events ∪ all 7 `LOCKED_EVENTS`. Rename test title to drop the "issues" specificity (e.g., `"should reactivate inactive webhook and add all LOCKED_EVENTS when missing"`).
  - `webhook-setup-service.test.ts:997–1032` (`"should reactivate inactive webhook with empty events array"`) — update expected `events` to all 7 `LOCKED_EVENTS`.
  - Grep for any additional `events: ['issues']` / `events: ['push', 'issues']` assertions on the reactivate branch and update to the LOCKED_EVENTS union.

- [X] T008 [US1][US2] Add NEW test in the `describe('ensureWebhooks — create branch', ...)` block: `"SC-001: newly-created webhooks carry the full 7-event LOCKED_EVENTS set"`. Assert the `POST /repos/.../hooks` `executeCommand` argv includes `-F events[]=<name>` for each of the 7 events (matches FR-006 + SC-001).

- [X] T009 [US3] Add NEW test in the `describe(...)` block covering the `skip-active` branch: `"SC-003: idempotent — active hook already matching LOCKED_EVENTS is not PATCHed"`. Seed a mock hook with `active: true`, `config.url` matching, and `events: [...LOCKED_EVENTS]`. Run `_ensureWebhookForRepo`. Assert `executeCommand` was called exactly once (list only, no PATCH), `result.action === 'skipped'`, `summary.skipped === 1`, `summary.reactivated === 0`, and only the existing `'Webhook already exists and is active'` info line was emitted (V4 / FR-008 / SC-003).

- [X] T010 [US4] Add dedicated SC-004 assertion (may be a new test or extend T007's first entry): `"SC-004: reactivated inactive hook receives full LOCKED_EVENTS union"`. Seed a mock hook with `active: false, events: ['issues']`. Assert the resulting PATCH argv has `-F active=true` AND `-F events[]=<name>` for each of the 7 `LOCKED_EVENTS`.

## Phase 4: Tests — `packages/orchestrator/src/services/__tests__/smee-receiver-987.test.ts`

- [X] T011 [P] [US1][US2] Optional low-cost annotation — Add a comment block above tests 6, 7, 8 (`pull_request_review.submitted`, `pull_request_review_comment.created`, `issue_comment.created`) citing `#1092 SC-005` so future readers understand these tests are the pins for the widened `LOCKED_EVENTS` producer subscription. No behavioral change; no new tests unless review discovers a missing branch (plan.md § "Edit locations — smee-receiver-987.test.ts").

## Phase 5: Verification

- [X] T012 Run the modified test suite: `pnpm --filter @generacy-ai/orchestrator test webhook-setup-service.test.ts smee-receiver-987.test.ts`. All existing branch tests (`create`, `update-url`, `skip-active`, `reactivate`, `foreign`) still pass; new tests (T006/T008/T009/T010) pass; smee-receiver tests 6/7/8 pass without modification.

- [X] T013 Run the four grep-verification checks from quickstart.md §§ 1–4 against the diff:
  - §1: `git diff develop -- packages/orchestrator/src/services/webhook-setup-service.ts | grep -A3 LOCKED_EVENTS` shows three new entries and NO `pull_request_review_thread`.
  - §2: `grep -n "missing events — patched\|missingEvents\|newEvents" packages/orchestrator/src/services/webhook-setup-service.ts` shows one `logger.info` call with the new message and the two structured fields.
  - §3: `grep -n "events not updated\|expectedEvents.*'issues'" packages/orchestrator/src/services/webhook-setup-service.ts` returns **zero** matches (pre-fix warn line deleted).
  - §4: `grep -n "hook.events, 'issues'\]" packages/orchestrator/src/services/webhook-setup-service.ts` returns **zero** matches (pre-fix reactivate string-merge replaced).

- [ ] T014 Pre-fix regression demonstration (SC-007): `git worktree add ../generacy-1092-baseline HEAD~1`, `pnpm install --frozen-lockfile`, `pnpm --filter @generacy-ai/orchestrator test webhook-setup-service.test.ts`. Expected: T006 (`"should heal active webhook when events subset of LOCKED_EVENTS"`) AND the updated reactivate-events tests (T007) fail against the pre-fix source. Capture the failure output for the PR description. Clean up with `git worktree remove ../generacy-1092-baseline`.

- [X] T015 Confirm no consumer-side files were modified (FR-009 / FR-010 / V7). `git diff --name-only develop...HEAD` MUST show only:
  - `packages/orchestrator/src/services/webhook-setup-service.ts`
  - `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts`
  - `packages/orchestrator/src/services/__tests__/smee-receiver-987.test.ts` (only if T011 landed)
  - `.changeset/1092-widen-locked-events.md`
  - `specs/1092-summary-webhooksetupservice/*` (this spec dir)

  Explicitly NOT in the diff: `smee-receiver.ts`, `pr-feedback-monitor-service.ts`, `clarification-answer-monitor-service.ts`, `label-monitor-service.ts`, `adaptive-poll-controller.ts`, `routes/pr-webhooks.ts`, `cockpit/doorbell/smee-source.ts`.

- [ ] T016 Post-deploy operator smoke check (documented, NOT a CI gate — per Q4=C). Run per quickstart.md § "Operator post-deploy smoke test":
  - Submit `CHANGES_REQUESTED` review on a Generacy-managed PR; observe `pull_request_review` webhook event arriving via smee within seconds; `PrFeedbackMonitorService.processPrReviewEvent` fires.
  - Confirm `/webhooks/pr` route observes non-zero traffic (US1 acceptance criterion 3).
  - Post a clarification-answer comment on an issue carrying `waiting-for:clarification` + `agent:paused`; observe `ClarificationAnswerMonitorService.processClarificationAnswerEvent` fires via smee, not polling (US2).
  - On the first orchestrator boot after this fix ships against a cluster with pre-existing Generacy webhooks: expect one `info: Existing webhook was missing events — patched` line per managed repo (US3). Second boot: zero PATCH calls, only the existing `info: Webhook already exists and is active` line (FR-008 / SC-003).

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 (changeset) has no code dependencies but must land in the same PR — CI will red-flag its absence. Land early.
- T002 (widen constant) is prerequisite for T003, T004, and every test in Phase 3 (`LOCKED_EVENTS` referenced by every assertion). Do T002 first inside `webhook-setup-service.ts`.
- T003 (heal branch), T004 (reactivate merge), T005 (doc comment) all edit the same file and can be done in one editing session after T002.
- Phase 3 tests (T006–T010) all edit the same test file — sequential within the file, but any of them can start once Phase 2 is complete.
- T011 is independent of everything else; marked `[P]`.
- Phase 5 verification (T012–T016) runs after Phases 1–4 are complete.

**Parallel opportunities**:
- T001 (changeset in `.changeset/`) can be authored in parallel with any Phase 2/3 work.
- T011 (smee-receiver test comment) is entirely independent of the webhook-setup-service diff; marked `[P]`.
- T013 grep checks and T012 test run in Phase 5 are independent of each other and can run in parallel.

**Critical path**: T002 → T003 → T006 → T012 → T014. Everything else can slot around this backbone.

## Playbook coupling

`spec.md` does not reference any file matching `packages/claude-plugin-cockpit/commands/*.md`. The playbook-verification re-pin task is **not applicable** to this fix. Confirmed by grep against `spec.md` and `plan.md` — zero matches for the literal `packages/claude-plugin-cockpit/commands/` prefix.
