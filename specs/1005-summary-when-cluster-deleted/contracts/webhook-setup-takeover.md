# Contract: `WebhookSetupService` — single-hook take-over branch (Q5-C)

**Issue**: [#1005](https://github.com/generacy-ai/generacy/issues/1005)
**Scope**: `packages/orchestrator/src/services/webhook-setup-service.ts` — `_selectExistingHookForUpdate`

## Purpose

Belt-and-braces heal for the "adopt tier missed" case: on every `ensureWebhooks()` invocation (boot + every self-heal poll from any caller cadence), if the repo has exactly one Generacy smee hook AND its URL is stale (neither the current cluster's channel nor the persisted URL), repoint that hook via `update-url` to the current channel.

## Trigger conditions (all MUST be true)

1. `smeeHooks = hooks.filter(h => h.config?.url.toLowerCase().startsWith('https://smee.io/'))` — count is exactly 1.
2. That hook's URL is NOT the current cluster's channel URL (case-insensitive compare).
3. That hook's URL is NOT the persisted URL (case-insensitive compare), OR the persisted URL is null.
4. The existing branches that classify a hook as `skip-active`, `reactivate`, or `update-url` (persisted-match, already at `webhook-setup-service.ts:481-492`) did NOT fire first.

Under these conditions the decision is `{ kind: 'update-url', hook: smeeHooks[0] }` and the caller (`_ensureWebhookForRepo`) executes the existing `update-url` handler at `webhook-setup-service.ts:372-402` unchanged.

## Bail-out conditions

- **`smeeHooks.length === 0`** → no take-over → fall through to `create`. Standard first-boot / never-had-a-hook case.
- **`smeeHooks.length >= 2`** → no take-over. The existing `foreign` branch's first-match `.find(…)` fires and returns `{ kind: 'foreign', hook: <first stale smee hook> }`, preserving the pre-fix log-and-skip behavior for the multi-hook accumulation case.

The ≥2 bail-out is the load-bearing safety property for SC-004 (0 duplicate label events). Repointing multiple hooks to one channel would cause GitHub to deliver duplicate events → duplicate `Processing … source=webhook` per label change → the monitor's Redis dedup is per-key not per-hook so the duplicates would land as duplicate processing runs.

## Ordering vs. existing branches in `_selectExistingHookForUpdate`

The new take-over branch is inserted between the existing `persisted-match` branch and the existing `foreign` branch:

```
1. exact-match on current URL → skip-active | reactivate       (existing, unchanged)
2. exact-match on persisted URL → update-url                    (existing, unchanged — FR-004 stale-channel-rotation from #972)
3. NEW: single Generacy smee hook, URL stale → update-url       (this branch)
4. any Generacy smee hook, URL stale → foreign (log-and-skip)   (existing, semantics preserved for the ≥2 case)
5. no match → create                                            (existing, unchanged)
```

Ordering rationale:

- Branch 1 handles "we're already registered on the current channel" — cheap short-circuit.
- Branch 2 handles the #972 rotation case: current cluster kept its persisted file across a channel rotation. Distinct semantics from the new branch: branch 2 knows the exact prior URL from the persisted file, branch 3 does not.
- Branch 3 is exactly the delete→relaunch case that this fix targets: persisted file is gone (or was never written), a Generacy hook survives the wipe, and there's exactly one of them.
- Branch 4 is unchanged in behavior for the ≥2 case (log-and-skip). Its match set implicitly shrinks by branch 3 taking single-hook cases.
- Branch 5 unchanged.

## Interaction with `findExistingSmeeChannel` (adopt tier)

Adopt (A) and take-over (B) are complementary, not redundant:

- **Adopt fires** → the resolver's `channelUrl` becomes the adopted URL. On the very next `ensureWebhooks()` call, branch 1 fires (the current URL matches the surviving hook) and returns `skip-active`. Take-over never runs on that hook. This is the intended steady state.
- **Adopt misses** (transient callback failure, or the cluster was configured with only presetUrl and never saw an adopt tier) → provision happens, current URL is fresh. On the next `ensureWebhooks()` call, branch 3 fires and repoints the surviving hook to the fresh channel. One hop of healing.
- **Adopt misses AND ≥2 stale smee hooks exist** → provision happens, and take-over ALSO bails on ≥2. The cluster boots into polling mode. Ops-side cleanup of the accumulated cruft is required to converge — matches the "one-time ops repair out of scope" bullet in the spec.

## Post-`update-url` result

Return the existing `WebhookSetupResult` shape with `action: 'reactivated'` (matching the pre-existing `update-url` handler's return at `webhook-setup-service.ts:401`). Log format also unchanged — same "Updated Generacy webhook to current channel URL" info line.

Do NOT introduce a new `action` value (e.g., `'took-over'`). The existing vocabulary (`created` / `skipped` / `reactivated` / `failed`) is sufficient; downstream consumers of `WebhookSetupSummary` (currently only the log line in `server.ts:618-620`) do not care about the taxonomy split.

## Idempotency

- Take-over fires at most once per repo per `ensureWebhooks()` invocation (branch 3 returns `{ kind: 'update-url' }` and `_ensureWebhookForRepo` returns immediately after handling it).
- On the next `ensureWebhooks()` invocation, that hook's URL now equals `current`, so branch 1 fires and returns `skip-active`. Take-over does NOT re-fire.
- If a self-heal-poll cadence exists that calls `ensureWebhooks()` repeatedly (e.g., every 60 s), the take-over is a no-op after the first hit.

## GitHub API call

Uses the existing `_updateRepoWebhookConfig(owner, repo, hookId, { url: currentUrl, active: true, events: [...LOCKED_EVENTS] })` at `webhook-setup-service.ts:837-864`. No new endpoint, no new argv shape.

Failure path: on non-zero exit, the existing `_handleGhFailure(owner, repo, error, 'patch', ...)` fires. 403 → fail-loud triple (see #972 contracts). Other codes → warn-only. Returns `WebhookSetupResult` with `action: 'failed'`.

## Non-goals for this contract

- Bulk sweep of ≥2 stale hooks. Explicitly out of scope; ops cleanup.
- Deleting stale hooks (via `DELETE /repos/:o/:r/hooks/:id`). Explicitly out of scope; non-destructive by decision D3.
- Handling non-`smee.io` foreign webhooks. Unchanged from today — the existing `foreign` classifier and its skip semantics are preserved for that case.

## Test surface

- T-takeover-1..4 in plan.md §Line-of-effect. T-takeover-2 (≥2 hooks → no update-url) is the SC-004 safety assertion.
- Regression coverage: T-takeover-4 (after adopt fires, the repointed hook is current → `skip-active`, take-over does NOT re-fire).
