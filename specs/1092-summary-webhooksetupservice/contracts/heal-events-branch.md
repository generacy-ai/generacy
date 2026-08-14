# Contract — `WebhookSetupService._ensureWebhookForRepo` skip-active heal + reactivate full-set merge

## Scope

Extends rows 4 and 5 of the #972 decision matrix (`specs/972-summary-snappoll-preview/contracts/ensure-webhooks-behavior.md`) with post-#1092 semantics. Does not modify the #972 contract file (frozen artifact on a merged branch); this contract supersedes rows 4 and 5 for consumers reading from the #1092 branch onward.

## Constants

```
LOCKED_EVENTS = [
  'issues',
  'pull_request',
  'check_run',
  'check_suite',
  'pull_request_review',            // NEW post-#1092
  'pull_request_review_comment',    // NEW post-#1092
  'issue_comment',                  // NEW post-#1092
]
```

Set membership; order irrelevant for correctness. Wire order (in the `gh api -F events[]=<name>` argv) matches the tuple order for reviewer predictability but does not affect GitHub's semantics.

## Extended decision matrix (rows 4 and 5)

Evaluated after rows 1–3 (list errors); first match wins.

| # | Condition | Action | Result | Log |
|---|-----------|--------|--------|-----|
| 4a | List returns 200 + hook with `matches(config.url, smeeChannelUrl)` AND `active === true` AND `hook.events ⊇ LOCKED_EVENTS` | No PATCH. | `{ action: 'skipped', webhookId }` | `info: Webhook already exists and is active` |
| **4b** (NEW) | List returns 200 + hook with `matches(config.url, smeeChannelUrl)` AND `active === true` AND `hook.events ⊉ LOCKED_EVENTS` (i.e. `missingEvents.length > 0`) | PATCH the hook via `_updateRepoWebhook(owner, repo, id, { events: [...new Set([...hook.events, ...LOCKED_EVENTS])] })`. Preserves `hook.events` extras. Does NOT touch `active`, `config.url`, or `config.content_type`. | `{ action: 'reactivated', webhookId }`; `summary.reactivated++` | `info: Existing webhook was missing events — patched` with `{owner, repo, webhookId, missingEvents, newEvents}` |
| **5** (MODIFIED) | List returns 200 + hook match on current URL AND `active === false` | PATCH the hook to `{ active: true, events: [...new Set([...hook.events, ...LOCKED_EVENTS])] }`. Previously merged only `'issues'`; post-#1092 merges the full 7-event set. | `{ action: 'reactivated', webhookId }`; `summary.reactivated++` | `info: Reactivated inactive webhook` with `{owner, repo, webhookId, action, events}` (existing shape; `events` payload now includes full merge) |
| 7 | PATCH from row 4b or 5 returns 403 | Route through `_handleGhFailure(..., 'patch', ...)` → fail-loud triple (log + relay + `degraded` status). Return `{ action: 'failed', error: 'webhook-registration-forbidden' }`. Do NOT increment `summary.reactivated`; increment `summary.failed`. | `{ action: 'failed', ... }` | `warn: Webhook registration forbidden: missing admin:repo_hook scope` (existing shape) |
| 7b | PATCH from row 4b or 5 returns 404/500/other | Route through `_handleGhFailure(..., 'patch', ...)` → warn only. Return `{ action: 'failed', error: <stderr> }`. | `{ action: 'failed', ... }` | `warn: Failed to manage webhook for repository` (existing shape) |

Rows 6, 8, 9, 10, 11 unchanged from the #972 contract.

## Log-line contract — row 4b heal (FR-004)

Exactly one log call per heal:

```json
{
  "level": "info",
  "msg": "Existing webhook was missing events — patched",
  "owner": "<owner>",
  "repo": "<repo>",
  "webhookId": <number>,
  "missingEvents": ["<event1>", ...],
  "newEvents": ["<preserved1>", ..., "<lockedNotAlreadyPresent1>", ...]
}
```

Field rules:
- `missingEvents` — the array `LOCKED_EVENTS.filter(e => !hook.events.includes(e))` computed at heal time. Non-empty by construction (heal only fires when non-empty).
- `newEvents` — the array actually sent to GitHub in the PATCH body. `[...new Set([...hook.events, ...LOCKED_EVENTS])]`. Always a superset of both `hook.events` (Assumption 2 — preserves operator extras) and `LOCKED_EVENTS`.
- No `expectedEvents` field. The pre-fix `expectedEvents: ['issues']` field is DELETED (was misleading pre-fix, meaningless post-fix — the invariant is "LOCKED_EVENTS ⊂ hook.events", not any single-string equality).

The pre-fix `logger.warn(..., 'Existing webhook has event mismatch - events not updated')` is DELETED. No warn is emitted on the heal path.

## PATCH-body contract — row 4b (FR-002)

The PATCH argv sent to `executeCommand('gh', args, { env })`:

```
[
  'api',
  '-X', 'PATCH',
  '/repos/{owner}/{repo}/hooks/{webhookId}',
  '-F', 'events[]=<newEvents[0]>',
  '-F', 'events[]=<newEvents[1]>',
  ...
  '-F', 'events[]=<newEvents[n-1]>',
]
```

Explicitly NOT included:
- `-F active=<...>` (no active-flag flip; hook is active by construction).
- `-f config[url]=<...>` (no URL rewrite; hook URL matches by construction).
- `-f config[content_type]=<...>` (no content-type rewrite; out of scope per Q2=A).

This is exactly the shape `_updateRepoWebhook(owner, repo, id, { events: newEvents })` produces today when `updates.active === undefined`. No new helper.

## PATCH-body contract — row 5 (FR-005)

The PATCH argv sent to `executeCommand('gh', args, { env })`:

```
[
  'api',
  '-X', 'PATCH',
  '/repos/{owner}/{repo}/hooks/{webhookId}',
  '-F', 'active=true',
  '-F', 'events[]=<merged[0]>',
  '-F', 'events[]=<merged[1]>',
  ...
  '-F', 'events[]=<merged[n-1]>',
]
```

Where `merged = [...new Set([...hook.events, ...LOCKED_EVENTS])]`. Row 5 preserves the `active=true` flip (that's the whole point of reactivate); only the event-set width changes vs. pre-fix.

## PATCH-body contract — row 4a (unchanged)

Zero PATCH calls. Only the list call is made. The existing `logger.info(..., 'Webhook already exists and is active')` fires.

## Idempotency contract (FR-008 / SC-003)

For any hook `H`:

```
Given:  H.active === true
        H.config.url === smeeChannelUrl
        LOCKED_EVENTS ⊆ H.events   (i.e. missingEvents === [])

When:   _ensureWebhookForRepo(owner, repo, smeeChannelUrl, persistedUrl) runs

Then:   executeCommand call count == 1  (list only)
        result === { owner, repo, action: 'skipped', webhookId: H.id }
        summary.skipped incremented by 1
        summary.reactivated NOT incremented
        exactly one log line: info 'Webhook already exists and is active'
        zero warn lines
```

Guarantees no boot-log noise, no GitHub API churn, no counter drift on repeat.

## Non-idempotent case (SC-002 — first boot after upgrade)

For any hook `H`:

```
Given:  H.active === true
        H.config.url === smeeChannelUrl
        H.events == some subset of LOCKED_EVENTS  (e.g. pre-#1092 4-event set)

When:   _ensureWebhookForRepo(...) runs

Then:   executeCommand call count == 2  (list + one PATCH)
        PATCH body includes 'events[]=<name>' for each of LOCKED_EVENTS
                            \ H.events  AND each pre-existing entry in H.events
        result === { owner, repo, action: 'reactivated', webhookId: H.id }
        summary.reactivated incremented by 1
        exactly one log line: info 'Existing webhook was missing events — patched'
        zero warn lines
```

Second boot on the same repo enters the idempotent case above (row 4a). No repeat PATCH.

## Wire-order determinism

The tuple order in `LOCKED_EVENTS` (as declared in `webhook-setup-service.ts`) is preserved on the wire. `[...new Set([...hook.events, ...LOCKED_EVENTS])]` interleaves preserved `hook.events` entries first, then LOCKED_EVENTS entries not already present, in tuple order. Tests may assert exact order for readability but the GitHub API is order-insensitive; use `expect.arrayContaining([...LOCKED_EVENTS])` where order-tolerance is preferable.

## Interaction with #1005 take-over

The #1005 `staleGeneracySmee` take-over branch at `webhook-setup-service.ts:565–579` fires in `_selectExistingHookForUpdate` BEFORE the heal branch — take-over produces `kind: 'update-url'` which routes to `_updateRepoWebhookConfig` (row 6) with `events: [...LOCKED_EVENTS]`. Heal never fires on a taken-over hook because the URL is being rewritten to `smeeChannelUrl` on the same call, so on the next boot the hook enters row 4a directly. No ordering hazard.

## Interaction with #972 URL heal (row 6)

Row 6 (URL heal via `_updateRepoWebhookConfig`) already writes `events: [...LOCKED_EVENTS]` post-#972. Widening `LOCKED_EVENTS` from 4 → 7 transparently upgrades URL-heal hooks in the same PATCH. No separate change needed for row 6 (per FR-006).
