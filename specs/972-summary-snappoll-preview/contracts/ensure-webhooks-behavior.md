# Contract — `WebhookSetupService.ensureWebhooks()` Per-Repo Decision Matrix

## Scope

Per-repo behavior of `WebhookSetupService._ensureWebhookForRepo(owner, repo, smeeChannelUrl)`. Locks the outputs required by FR-001 (locked events), FR-004 (exact-URL match) and FR-002/FR-003/FR-006 (loud failure).

## Inputs

| Input | Source | Notes |
|-------|--------|-------|
| `owner`, `repo` | `RepositoryConfig` from `config.repositories` | |
| `smeeChannelUrl` | current channel URL (from `SmeeChannelResolver` result) | Non-empty; validated to `SMEE_URL_PATTERN` at resolver tier. |
| `existingHooks` | `GET /repos/{owner}/{repo}/hooks` | `GitHubWebhook[]`; empty array on error. |
| `previouslyPersistedUrl` | `readFile(config.smee.channelFilePath, 'utf-8')` | `string \| null`; null on ENOENT or invalid content. |
| `installationId` | `.agency/credentials.yaml` github-app entry, resolved once at startup | `number \| null`. |

## Locked create-time payload (FR-001)

When creating a new hook, the request MUST include exactly these events:

```
events[] = issues
events[] = pull_request
events[] = check_run
events[] = check_suite
```

Plus:
- `config[url] = <smeeChannelUrl>`
- `config[content_type] = json`
- `active = true`

## Decision matrix (FR-004 + FR-002)

Evaluated in order — first match wins. `matches(A, B)` = case-insensitive string equality.

| # | Condition | Action | Result |
|---|-----------|--------|--------|
| 1 | List returns HTTP 403 | Emit log + relay event + `degraded` status; return `{ action: 'failed', error: 'webhook-registration-forbidden' }` | Loud failure |
| 2 | List returns HTTP 404 | Warn log only (repo not found); return `{ action: 'failed', error: <stderr> }` | Existing behavior (no scope-attributable failure) |
| 3 | List returns HTTP 500 | Warn log only; return `{ action: 'failed', error: <stderr> }` | Existing behavior |
| 4 | List returns 200 + `existingHooks` contains a hook with `matches(config.url, smeeChannelUrl)` AND `active === true` | Log `Webhook already exists and is active`; if hook's `events` array is missing any of the four locked events, warn about the event mismatch (do NOT PATCH — matches existing behavior on `active`-and-URL-match). Return `{ action: 'skipped', webhookId }` | Idempotent no-op |
| 5 | List returns 200 + hook match on current URL AND `active === false` | PATCH the hook to `active: true` with `events` merged to the four locked events; return `{ action: 'reactivated', webhookId }` | Existing reactivate behavior, extended to full event set |
| 6 | List returns 200 + no hook with current URL match, BUT `previouslyPersistedUrl != null` AND `previouslyPersistedUrl !== smeeChannelUrl` AND `existingHooks` contains a hook with `matches(config.url, previouslyPersistedUrl)` | PATCH the hook's `config.url` to `smeeChannelUrl` (and events to the four locked events, and `active: true`). Log `Updated Generacy webhook to current channel URL` with old/new URLs. Return `{ action: 'reactivated', webhookId }` | **NEW: FR-004 stale-channel heal** |
| 7 | PATCH from row 5 or 6 returns 403 | Emit log + relay event + `degraded` status; return `{ action: 'failed', error: 'webhook-registration-forbidden' }` | Loud failure |
| 8 | List returns 200 + no match on either current or persisted URL | Skip: log `Foreign webhook present; not modifying` with the hook id and truncated URL. Return `{ action: 'skipped', webhookId: <foreign-hook-id> }` | **NEW: FR-004 clobber-prevention** |
| 9 | List returns 200 + `existingHooks` is empty (or no match on rows 4–8) | Create new hook (see locked payload above); return `{ action: 'created', webhookId }` | Existing create behavior, with locked event set |
| 10 | POST from row 9 returns 403 | Emit log + relay event + `degraded` status; return `{ action: 'failed', error: 'webhook-registration-forbidden' }` | Loud failure |
| 11 | POST from row 9 returns any other error | Warn log only; return `{ action: 'failed', error: <stderr> }` | Existing behavior |

## Non-goals (out of scope for this contract)

- Event-set migration for existing hooks with `active === true` (row 4) — leaves the existing event-mismatch warning behavior in place, does not PATCH. Rationale: PATCH on an already-active hook risks disturbing an operator-tuned configuration for a hook we do not fully own; the event-set enforcement applies only to hooks we create or reactivate.
- Foreign hook cleanup — row 8 explicitly does not touch the hook.
- Zero-restart re-run of `ensureWebhooks()` on receipt of a cloud message — deferred (Q4 → A).

## Idempotency

- Multiple `ensureWebhooks()` invocations within one boot produce the same outputs for the same inputs (list + persisted-file read are pure).
- Row 4 (skipped-because-active) is the steady state — every boot after the first hits this row for a healthy repo.
- Row 6 (stale-channel heal) fires at most once per orchestrator boot (after PATCH the row-4 condition then holds).

## Observability

- Each row emits exactly one log line at `info` level (rows 4, 5, 6, 8, 9) or `warn` level (rows 1, 2, 3, 7, 8-log, 10, 11).
- Rows 1, 7, 10 (the three 403 paths) additionally emit the relay event + status transition per `webhook-registration-forbidden-event.md`.
- Row 8 (`Foreign webhook present`) is a `warn`, not an `info`, to make the clobber-prevention visible to operators auditing pre-existing repos.
