# Tasks: Snappoll Preview — Fail Loud on Webhook-Registration 403

**Input**: Design documents from `/specs/972-summary-snappoll-preview/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = fail-loud on 403; US2 = self-heal on restart, no code beyond US1)

All P1 requirements land in `packages/orchestrator/`. No cross-package edits, no new relay channels, no new IPC endpoints. FR-009 (P2) is out of scope for this issue.

---

## Phase 1: Core — `WebhookSetupService` behavioral changes

Order within this phase is sequential — every task edits `packages/orchestrator/src/services/webhook-setup-service.ts` (same file). Do NOT mark `[P]` between them.

- [ ] T001 [US1] Extend `WebhookSetupService` constructor with optional dependency-injection hooks in
      `packages/orchestrator/src/services/webhook-setup-service.ts`:
      - `sendRelayEvent?: (channel: string, payload: unknown) => void`
      - `statusReporter?: { pushStatus(status: ClusterStatus, reason: string): Promise<void> }`
      - `channelFilePath?: string` (default `/var/lib/generacy/smee-channel`)
      - `installationIdProvider?: () => Promise<number | null>`
      All optional so existing test suite keeps working; when a hook is absent the corresponding
      side-effect is a no-op (matches current behavior). Add matching TypeScript types alongside
      existing `RepositoryConfig` / `GitHubWebhook` / `WebhookSetupResult`.

- [ ] T002 [US1] FR-001 — Lock the four spec-locked events in `_createRepoWebhook` in
      `packages/orchestrator/src/services/webhook-setup-service.ts`. The `gh api` call MUST emit
      `-F events[]=issues -F events[]=pull_request -F events[]=check_run -F events[]=check_suite`,
      plus `-F config[url]=<smeeChannelUrl> -F config[content_type]=json -F active=true`
      (see `contracts/ensure-webhooks-behavior.md` §"Locked create-time payload").

- [ ] T003 [US1] FR-004 — Add persisted-URL exact-match decision matrix in
      `packages/orchestrator/src/services/webhook-setup-service.ts`. Extract `_selectExistingHookForUpdate`
      (or equivalent) implementing rows 4–8 of `contracts/ensure-webhooks-behavior.md`:
      - Row 4: exact match on current channel URL AND `active === true` → skip (idempotent no-op).
      - Row 5: match on current URL AND `active === false` → PATCH `active: true` + merge locked events.
      - Row 6 (NEW): no current-URL match, `previouslyPersistedUrl != null`, hook exists whose
        `config.url` matches persisted URL case-insensitively → PATCH `config.url` to current URL,
        `active: true`, events set to the four locked events. Log
        `"Updated Generacy webhook to current channel URL"` with old/new URLs.
      - Row 8 (NEW): no match on either current or persisted URL → log `"Foreign webhook present;
        not modifying"` at `warn` with hook id + truncated URL and return `{ action: 'skipped', webhookId }`.
      Read persisted URL from `channelFilePath` (from T001 DI); return `null` on ENOENT or invalid content.
      Case-insensitive string equality per `data-model.md` §"Field-Level Validation Rules Summary".

- [ ] T004 [US1] FR-002 + FR-003 + FR-006 — Wire the 403 fail-loud triple in the
      `_ensureWebhookForRepo` catch branch in
      `packages/orchestrator/src/services/webhook-setup-service.ts`. When `gh api` stderr matches
      (case-insensitive substring) `HTTP 403` OR `Resource not accessible by integration` on any of
      list-hooks / POST-hook / PATCH-hook, emit **in order**:
      1. Refined Pino `warn` log line — the existing line at ~`:384` becomes
         `msg: "Webhook registration forbidden: missing admin:repo_hook scope"` with fields
         `owner`, `repo`, `installationId`, `missingScope: "admin:repo_hook"`,
         `reason: "webhook-registration-forbidden"`, `ghStderr` (raw stderr, token-redacted).
      2. `sendRelayEvent('cluster.bootstrap', { status: 'failed',
         reason: 'webhook-registration-forbidden', repo: `${owner}/${repo}`,
         installationId, missingScope: 'admin:repo_hook' })` — payload exactly per
         `contracts/webhook-registration-forbidden-event.md`.
      3. `statusReporter.pushStatus('degraded', 'webhook-registration-forbidden')` — payload per
         `contracts/degraded-status-transition.md`.
      Emit at most once per `(repo, orchestrator boot)`. All three are fire-and-forget except the
      log line (synchronous). Return `{ action: 'failed', error: 'webhook-registration-forbidden' }`.
      Do NOT fire on 404 or 500 — those keep existing warn-only behavior (rows 2, 3, 11 of the
      decision matrix). Reuse `installationIdProvider` from T001 (resolved once, cached; emit `null`
      if unresolved).

---

## Phase 2: Wiring
<!-- Phase boundary: Complete Phase 1 before starting Phase 2 -->

- [ ] T005 [US1] Wire the DI hooks in `packages/orchestrator/src/server.ts` at the
      `WebhookSetupService` construction site (currently `~:508`):
      - Pass `sendRelayEvent` — reuse the same closure already built for `PostActivationRetryService`
        at `~:723-727` / `BootResumeService` at `~:1135-1138`; it wraps `ClusterRelayClient.send`.
      - Pass `statusReporter` (or its `.pushStatus` bound method) — the same instance already used
        by `PostActivationRetryService`.
      - Pass `channelFilePath` from `config.smee.channelFilePath` (already resolved by
        `SmeeChannelResolver`).
      - Pass `installationIdProvider` — a closure that resolves the default `github-app` credential
        id once at startup from `.agency/credentials.yaml` (same read pattern as
        `github-auth-health.ts` / `credential-expiry-watcher.ts`), returning `number | null`.

---

## Phase 3: Tests
<!-- Phase boundary: Complete Phase 2 before starting Phase 3 -->

- [ ] T006 [US1] Extend
      `packages/orchestrator/src/services/__tests__/webhook-setup-service.test.ts` with the seven
      cases spec'd in plan.md §"Project Structure" line-of-effect table:
      1. 403 on list → emits log + relay event + `pushStatus('degraded', ...)`.
      2. 403 on create → same triple.
      3. 200 on create → no relay event, no status change (baseline regression).
      4. Existing hook whose `config.url` matches current channel exactly → skipped (row 4).
      5. Existing hook whose `config.url` matches persisted URL from `channelFilePath` (but not
         current) → PATCHed to current URL + locked events + `active: true` (row 6).
      6. Existing hook whose `config.url` matches neither current nor persisted → log-and-skip,
         no PATCH (row 8 clobber-prevention).
      7. Assert the create payload includes all four locked events (`issues`, `pull_request`,
         `check_run`, `check_suite`).
      Use stubbed `sendRelayEvent`, `statusReporter.pushStatus`, and `channelFilePath` reader —
      the existing `_executeGh` / `gh` mocking pattern in this file already covers the transport.

- [ ] T007 [P] [US1] Create
      `packages/orchestrator/src/__tests__/server-webhook-setup-loud-failure.test.ts` — server-level
      regression per plan.md line-of-effect table. Boot orchestrator (in-process, existing test
      pattern from sibling server tests), inject a fake `gh` runner that returns 403 for repo-hook
      list/create, and assert:
      - Exactly one `EventMessage` with `event === 'cluster.bootstrap'` and `data.reason ===
        'webhook-registration-forbidden'` reaches the relay client's `send()`.
      - Exactly one `POST /internal/status` with body `{ status: 'degraded',
        statusReason: 'webhook-registration-forbidden' }` reaches the control-plane socket.
      This test guards against a future refactor that drops one of the two loud-failure signals
      (SC-002 anchor). This file is NEW and does not overlap with T006 — the two tests may be
      written and iterated on in parallel once Phase 2 lands.

---

## Phase 4: Release + Verification

- [ ] T008 [US1] Add `.changeset/972-webhook-registration-fail-loud.md` with a `patch` bump for
      `@generacy-ai/orchestrator`. Required by the CI changeset gate (`CLAUDE.md` §"Changesets");
      no new public API means `patch` per the gate's "internal surface" rule. One-sentence summary
      naming the fail-loud triple.

- [ ] T009 [US1] Verification (do NOT skip — the plan's Diagnosis binds this fix to observable
      behavior, not to type checks):
      - `pnpm --filter @generacy-ai/orchestrator test` — the two test files from Phase 3 pass.
      - `pnpm --filter @generacy-ai/orchestrator typecheck` — DI additions compile cleanly.
      - `pnpm changeset status` — the new changeset is detected.
      - Manually walk the "Verifying the fail-loud path on a mis-provisioned cluster" section of
        `quickstart.md` at least on paper: for each of the three signals (log line, relay event,
        degraded status), confirm the code path from T004 emits the exact payload the contracts
        lock. If unable to boot a real cluster, note this explicitly in the PR body per
        `CLAUDE.md` §"For UI or frontend changes" (adapted: "if you can't test the UI, say so
        explicitly rather than claiming success").

---

## Out of scope for these tasks

- FR-009 (P2) — extending `SmeeWebhookReceiver` to handle `pull_request` / `check_run` / `check_suite`
  and rewiring the pr-feedback + merge-conflict monitors. Deferred to a follow-on issue per the
  spec's Out of Scope.
- The Generacy GitHub App manifest edit (grant `admin:repo_hook`). Documented in `quickstart.md`
  §"GitHub App manifest change" as an operator action; no code in this issue performs it.
- Any zero-restart in-place webhook repair via a `cluster.webhooks refresh-requested` message —
  Q4→A defers this. Pre-fix clusters heal on the next `generacy up` restart via the unchanged
  per-start `ensureWebhooks()` call site.

## Dependencies & Execution Order

**Sequential order (each blocks the next):**
- T001 (constructor DI) → T002, T003, T004 (all three rely on T001's DI shape).
- T002 → T003 → T004 within Phase 1 (same file, cumulative edits — do not attempt parallel patches).
- Phase 1 → T005 (server.ts wiring reads the DI shape T001 set).
- Phase 2 → Phase 3 (tests exercise the wired-up shape end-to-end).

**Parallel opportunity:**
- T006 and T007 mark `[P]` — different files (`__tests__/webhook-setup-service.test.ts` vs.
  `__tests__/server-webhook-setup-loud-failure.test.ts`), no shared state.

**Verification is terminal:**
- T008 and T009 land last. T008 is a hard CI-gate requirement (fail-fast — do this before pushing);
  T009 catches contract drift the type checker can't see.
