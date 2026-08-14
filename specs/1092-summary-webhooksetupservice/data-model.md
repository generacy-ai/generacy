# Data Model — #1092

## Scope

This fix is a behavior extension of an existing module. It introduces zero new types and modifies zero exported type shapes. This document names each type touched by the fix and pins the invariants that must hold post-change.

## Types

### `LOCKED_EVENTS` — module-private constant

```ts
// packages/orchestrator/src/services/webhook-setup-service.ts

/** Locked event set on all Generacy-created/updated webhooks (FR-001). */
const LOCKED_EVENTS = [
  'issues',
  'pull_request',
  'check_run',
  'check_suite',
  'pull_request_review',           // NEW — feeds PrFeedbackMonitorService (review-body path)
  'pull_request_review_comment',   // NEW — feeds PrFeedbackMonitorService (inline-comment path)
  'issue_comment',                 // NEW — feeds ClarificationAnswerMonitorService
] as const;
```

**Type**: `readonly ['issues', 'pull_request', 'check_run', 'check_suite', 'pull_request_review', 'pull_request_review_comment', 'issue_comment']` — TypeScript infers the tuple type from `as const`.

**Consumers (all in-file)**:
- `_createRepoWebhook` at `webhook-setup-service.ts:848` — iterates via `for (const event of LOCKED_EVENTS)` to build `-F events[]=<name>` argv.
- `_updateRepoWebhookConfig` at `webhook-setup-service.ts:924` (URL-heal branch) — spread as `events: [...LOCKED_EVENTS]` argument.
- `_ensureWebhookForRepo` skip-active branch at `webhook-setup-service.ts:393` — `LOCKED_EVENTS.filter(e => !hook.events.includes(e))` to compute `missingEvents`.
- `_ensureWebhookForRepo` reactivate branch at `webhook-setup-service.ts:415` (post-fix) — spread as `[...new Set([...hook.events, ...LOCKED_EVENTS])]`.

**Not exported** — the constant is module-private. Widening the tuple is not a public API change.

### `WebhookSetupResult` — exported, unchanged

```ts
export interface WebhookSetupResult {
  owner: string;
  repo: string;
  /**
   * Action taken during webhook setup
   * - `created`: New webhook was created
   * - `skipped`: Active webhook already exists (or a foreign hook was left alone)
   * - `reactivated`: Inactive webhook was reactivated, persisted-URL match PATCHed,
   *                  OR active-hook event set healed to include missing LOCKED_EVENTS
   *                  (post-#1092)
   * - `failed`: Setup failed (see `error` field)
   */
  action: 'created' | 'skipped' | 'reactivated' | 'failed';
  webhookId?: number;
  error?: string;
}
```

**Post-#1092 change**: only the doc-comment on the `reactivated` bullet is extended. The union itself is unchanged (Q1=A).

### `WebhookSetupSummary` — exported, unchanged

```ts
export interface WebhookSetupSummary {
  total: number;
  created: number;
  skipped: number;
  /** Number of webhooks reactivated (was inactive, persisted-URL healed,
   *  OR event-set healed on active hook — post-#1092) */
  reactivated: number;
  failed: number;
  results: WebhookSetupResult[];
}
```

**Post-#1092 change**: only the doc-comment on the `reactivated` field is extended.

### `GitHubWebhook` — exported, unchanged

```ts
export interface GitHubWebhook {
  id: number;
  active: boolean;
  config: { url: string };
  events: string[];  // NB: string[], not the LOCKED_EVENTS tuple — GitHub may return
                     // event types beyond LOCKED_EVENTS (operator additions, prior
                     // Generacy versions). Preserve on heal (Assumption 2).
}
```

## Validation rules & invariants

### V1 — LOCKED_EVENTS set membership (FR-001)

```ts
new Set(LOCKED_EVENTS) === new Set([
  'issues',
  'pull_request',
  'check_run',
  'check_suite',
  'pull_request_review',
  'pull_request_review_comment',
  'issue_comment',
])
```

Membership is set-equal, order-irrelevant. `pull_request_review_thread` MUST NOT be present (Assumption 7 / Decision 5).

### V2 — Heal PATCH is a strict superset union (FR-002, Assumption 2)

For any existing hook `H` on the heal (row-4-with-mismatch) branch, the PATCHed events array satisfies:

```
newEvents = [...new Set([...H.events, ...LOCKED_EVENTS])]
newEvents ⊇ H.events   // preserves operator-added extras
newEvents ⊇ LOCKED_EVENTS  // adds all missing locked events
```

The Set-based union preserves the caller's array-order semantics for existing entries, appending new locked events after. GitHub's PATCH endpoint accepts a full-replacement `events` array (Assumption 1); no delta-only API needed.

### V3 — Reactivate PATCH is a strict superset union (FR-005)

Same shape as V2, but applied on the row-5 branch (inactive hook, URL match). Replaces the pre-fix `[...new Set([...H.events, 'issues'])]` — which merged only the single string `'issues'` — with the full LOCKED_EVENTS spread.

### V4 — Idempotency (FR-008, SC-003)

For any hook `H` with `H.active === true`, `H.config.url === smeeChannelUrl`, and `H.events ⊇ LOCKED_EVENTS`:

```
_ensureWebhookForRepo(...) → { action: 'skipped', webhookId: H.id }
executeCommand call count == 1 (list only, no PATCH)
```

This is the steady state on every boot after the first.

### V5 — Public API stability (Q1=A)

```
WebhookSetupResult.action union unchanged: 'created' | 'skipped' | 'reactivated' | 'failed'
WebhookSetupSummary field set unchanged: { total, created, skipped, reactivated, failed, results }
No new exported types.
No new module-level constants exported.
```

### V6 — Log-line contract on heal (FR-004)

The heal branch emits exactly one log call:

```ts
logger.info(
  { owner, repo, webhookId, missingEvents, newEvents },
  'Existing webhook was missing events — patched'
);
```

Fields:
- `owner` — string, non-empty.
- `repo` — string, non-empty.
- `webhookId` — number, matches `H.id`.
- `missingEvents` — string[], non-empty (heal only fires when this is non-empty).
- `newEvents` — string[], equals V2's `newEvents`.

The pre-fix `logger.warn(..., 'Existing webhook has event mismatch - events not updated')` with `expectedEvents: ['issues']` is DELETED. No warn is emitted on the heal path.

### V7 — Consumer-side non-change (FR-009, FR-010)

Files that MUST NOT be modified:
- `packages/orchestrator/src/services/smee-receiver.ts`
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts`
- `packages/orchestrator/src/services/clarification-answer-monitor-service.ts`
- `packages/orchestrator/src/services/label-monitor-service.ts`
- `packages/orchestrator/src/services/adaptive-poll-controller.ts`
- `packages/orchestrator/src/routes/pr-webhooks.ts` (the `/webhooks/pr` route)
- `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts` (Assumption 6 — its event set is a strict subset of LOCKED_EVENTS)

Diff should show zero changes outside `webhook-setup-service.ts` + the two `__tests__/` files listed in `plan.md`.

## Relationships

```
┌─────────────────────────────────────────────────────────┐
│ webhook-setup-service.ts                                │
│                                                         │
│  LOCKED_EVENTS (7 entries after FR-001)                 │
│         │                                               │
│         ├──► _createRepoWebhook (POST /hooks)           │
│         │       events[] = each of LOCKED_EVENTS        │
│         │                                               │
│         ├──► _updateRepoWebhookConfig (URL heal)        │
│         │       events = [...LOCKED_EVENTS]             │
│         │                                               │
│         ├──► skip-active branch (row 4)                 │
│         │       missingEvents = LOCKED_EVENTS \ H.events│
│         │       if missing → PATCH via                  │
│         │         _updateRepoWebhook({ events: union }) │
│         │                                               │
│         └──► reactivate branch (row 5)                  │
│                 events = [...H.events, ...LOCKED_EVENTS]│
│                          (deduped)                      │
└─────────────────────────────────────────────────────────┘
                       │
                       ▼ (PATCH events array)
        GitHub REST API: PATCH /repos/{o}/{r}/hooks/{id}
                       │
                       ▼ (webhook now subscribes to full set)
              GitHub delivers events to smee.io
                       │
                       ▼
        SmeeWebhookReceiver.start() (unchanged, FR-009)
                       │
        ┌──────────────┼──────────────┬────────────────────┐
        ▼              ▼              ▼                    ▼
  LabelMonitor   PrFeedbackMonitor   MergeConflictMon   ClarificationMon
   (issues)     (pr_review*/pr)      (pr, check_*)     (issue_comment)
```

## Non-goals

- No new type exports.
- No changes to `RepositoryConfig`, `WebhookSetupServiceOptions`, or `Logger` interface.
- No changes to the `StatusReporterLike` DI seam or `_forbiddenFiredForRepo` bounding-set semantics.
