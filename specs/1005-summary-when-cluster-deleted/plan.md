# Implementation Plan: Adopt existing smee channel on cluster delete→relaunch

**Feature**: On a fresh/relaunched orchestrator (persisted smee-channel file missing), discover the repo's existing Generacy smee webhook, adopt its channel URL instead of provisioning a new one, and heal a stale single-hook via `update-url` on the self-heal path. Eliminates the "orphaned webhook + 5-min polling degradation" window observed on `snappoll` relaunch.
**Branch**: `1005-summary-when-cluster-deleted`
**Status**: Complete

## Summary

`SmeeChannelResolver.resolve()` currently has three tiers — `env-or-yaml → persisted → provisioned`. When a cluster is destroyed the persisted file dies with the volume; the resolver falls straight through to `provisioned`, so the relaunch listens on a brand-new smee channel while the repo's surviving GitHub webhook still points at the previous cluster's dead channel. `WebhookSetupService` classifies the surviving hook as `foreign` (URL matches neither `current` nor `persisted`) and leaves it alone. Result: label events degrade to the 5-minute polling fallback for the entire window between relaunch and next ops intervention.

This plan implements the (A)+(B) fix locked by the spec + clarifications:

- **(A) Adopt tier.** Insert a new resolver tier between `persisted` and `provisioned` that calls an injected `discoverExistingChannel(repos)` callback. On hit, the resolver returns `{ channelUrl, source: 'adopted' }` and persists the URL so the next boot short-circuits at the persisted tier. On throw/timeout it retries once (`MAX_ATTEMPTS = 2`, `RETRY_DELAY_MS = 1000`) then falls through to `provisioned` (Q4 → C).
- **(B) Single-hook take-over.** Extend `WebhookSetupService._selectExistingHookForUpdate` so a Generacy `https://smee.io/…` hook whose URL is neither current nor persisted is `update-url`-repointed to the current channel, **only when exactly one such hook exists on the repo** (Q5 → C). Zero or ≥2 → bail out; ≥2 keeps existing `foreign`/skip behavior to avoid duplicate-delivery (Q3 → A).
- **Discovery predicate.** `WebhookSetupService.findExistingSmeeChannel(repos)` — the callback (A) injects into the resolver — identifies "Generacy-owned" purely on URL prefix `https://smee.io/…` (Q1 → A). Iterates configured `repos` in order, returns the first repo's first smee.io hook URL, logs at `warn` if a later repo disagrees (Q2 → A).
- **Wiring.** `server.ts` constructs `WebhookSetupService` **before** `SmeeChannelResolver` on the `onReady` path so the resolver can accept a bound `webhookSetupService.findExistingSmeeChannel.bind(webhookSetupService)` as its `discoverExistingChannel` callback.

The env/yaml preset path and the persisted-hit fast path are untouched — no new GitHub API call on `docker restart` (FR-010, SC-003).

## Technical Context

**Language / runtime:** TypeScript, Node.js ≥ 22, ESM.
**Framework:** Fastify (orchestrator HTTP server), Pino (logging).
**Package boundary:** all changes land in `packages/orchestrator/`. No changes to `packages/control-plane/`, `packages/cluster-relay/`, `packages/workflow-engine/`, or `packages/generacy/` (CLI).
**Discovery transport:** reuses the existing `WebhookSetupService._listRepoWebhooks(owner, repo)` path — same `gh api /repos/:owner/:repo/hooks` call, same JIT `GH_TOKEN` provider, same error surface. No new HTTP client, no new auth code path.
**Resolver contract preserved:** `resolve()` still returns `SmeeChannelResolverResult | null` and every failure mode still folds into `return null` (fail-open). The new tier obeys the same discipline: bounded retry (2 attempts, 1s delay), then null-fallthrough into the next tier.
**Persistence:** on `adopted` hit the resolver reuses the existing `writePersistedFile()` write path so the next boot short-circuits at the persisted tier — same guarantee as `provisioned`. This is the load-bearing invariant that makes the second-and-later restart free.
**Wiring order:** the resolver is constructed inside the `server.addHook('onReady', …)` closure (`server.ts:641-679`). The `WebhookSetupService` is constructed inside `startSmeePipeline` (`server.ts:597`) *after* a channel URL is known. That order inverts under the fix — the resolver must accept a callback that reaches `WebhookSetupService.findExistingSmeeChannel`, so `WebhookSetupService` construction has to move above (or become injectable into) the resolver's construction site. See "Wiring" row in the change table below for the exact shape.
**Dependencies added:** none.

## Project Structure

```
packages/orchestrator/src/
├── server.ts                                    # MODIFIED: construct WebhookSetupService above resolver + wire callback
├── services/
│   ├── smee-channel-resolver.ts                 # MODIFIED: new 'adopted' tier, callback + source, persist-on-adopt, retry
│   ├── webhook-setup-service.ts                 # MODIFIED: findExistingSmeeChannel(repos) + single-hook take-over branch
│   └── __tests__/
│       ├── smee-channel-resolver.test.ts        # MODIFIED: T-adopt-* tiers (hit / miss / retry-then-hit / retry-exhausted)
│       └── webhook-setup-service.test.ts        # MODIFIED: findExistingSmeeChannel + take-over branch tests

specs/1005-summary-when-cluster-deleted/
├── spec.md                                      # UNCHANGED (read-only per /plan constraint)
├── clarifications.md                            # UNCHANGED
├── plan.md                                      # THIS FILE
├── research.md                                  # NEW
├── data-model.md                                # NEW
├── quickstart.md                                # NEW
└── contracts/
    ├── smee-channel-resolver-adopt-tier.md      # NEW: resolver ordering + adopt-tier contract
    ├── find-existing-smee-channel.md            # NEW: callback signature + multi-repo divergence rule
    └── webhook-setup-takeover.md                # NEW: single-hook take-over decision matrix (Q5-C)
```

### Line-of-effect summary

| File | Change | Requirement |
|------|--------|-------------|
| `smee-channel-resolver.ts` (type surface) | Add `'adopted'` to `ChannelSource`. Extend `SmeeChannelResolverOptions` with `discoverExistingChannel?: (repos: RepositoryRef[]) => Promise<string | null>` and `repos?: RepositoryRef[]`. Import a shared `RepositoryRef = { owner: string; repo: string }` type from `webhook-setup-service.ts` (or a new `types/repository.ts`). | FR-002, FR-008 |
| `smee-channel-resolver.ts` (`resolve()` body) | Insert new tier between the `persisted` return and the `provision()` call: if `options.discoverExistingChannel && options.repos`, call `runAdoptTier()`. On success → `writePersistedFile(url)` (best-effort; on fail, log at warn but still return `{ url, source: 'adopted' }` — the missed persistence retriggers adopt next boot, still safe), mirror-write, `logger.info({ channelUrl, source: 'adopted' }, 'Adopted existing smee channel URL from repo webhook')`, return. On null → fall through. | FR-001, FR-002, FR-008 |
| `smee-channel-resolver.ts` (`runAdoptTier()` new private) | Bounded retry: `for attempt in 1..MAX_ATTEMPTS { try { await discoverExistingChannel(repos) } catch { last = err; if attempt<MAX sleep(RETRY_DELAY_MS) } }`. Validate result with `SMEE_URL_PATTERN`; drop and log if invalid (defensive — callback is trusted but a malformed hook URL upstream would otherwise poison the persisted file). Return `null` on all failures. Never throws. | FR-007 |
| `webhook-setup-service.ts` (new `findExistingSmeeChannel(repos)`) | Iterate `repos` in order. For each: `_listRepoWebhooks(owner, repo)` (reuses the exact existing method; JIT token via `resolveTokenEnv`). Find first hook whose `config.url` matches `^https:\/\/smee\.io\/…` case-insensitively. Track `(chosenUrl, chosenRepo)` — first hit wins. On subsequent repos whose first smee hook URL differs from `chosenUrl`, log one `warn` per divergent repo (`{ chosenRepo, chosenUrl, divergentRepo, divergentUrl }`). Return `chosenUrl` or `null`. On `_listRepoWebhooks` throw for a given repo: log `warn`, skip that repo, continue — do not abort discovery (a single repo's 403 must not poison the adopt path across the whole cluster). | FR-003, FR-004 |
| `webhook-setup-service.ts` (`_selectExistingHookForUpdate`) | Extend after the current `foreign` branch. Compute `smeeHooks = hooks.filter(h => (h.config?.url ?? '').toLowerCase().startsWith('https://smee.io/'))`. If `smeeHooks.length === 1` AND that hook's URL is neither current nor persisted → return `{ kind: 'update-url', hook: smeeHooks[0] }`. If `smeeHooks.length >= 2` → fall through (existing `foreign` branch still fires for the first stale smee hook it finds → skip). If `smeeHooks.length === 0` → fall through to `create`. **Do not** repoint when the count is not exactly one. | FR-005, FR-006 |
| `server.ts` (`onReady` closure at `:641-679`) | Construct a `WebhookSetupService` instance **before** the resolver (with the same DI shape as the existing `startSmeePipeline` construction site, minus `sendRelayEvent`/`statusReporter` which are still fine to pass — they're used for the 403 path in `ensureWebhooks`, not `findExistingSmeeChannel`). Pass its `findExistingSmeeChannel.bind(webhookSetupService)` and `config.repositories` into `new SmeeChannelResolver(..., { …, discoverExistingChannel, repos })`. **Reuse the same instance downstream** — pass the constructed service into `startSmeePipeline` (or hoist `webhookSetupService` into the closure scope) so `ensureWebhooks()` is not called on a fresh instance. | Wiring |
| `server.ts` (`startSmeePipeline` at `:597`) | Accept the pre-constructed `WebhookSetupService` (or inline the wiring change above and stop instantiating here). Keeps the `ensureWebhooks(channelUrl, config.repositories)` call site unchanged. | Wiring |
| `smee-channel-resolver.test.ts` | New tests: **T-adopt-1** callback returns URL → source: 'adopted', persisted file written, no `fetch`. **T-adopt-2** callback returns null → falls through to `provision`. **T-adopt-3** callback throws once → retries once (sleep 1000) → returns URL on second call. **T-adopt-4** callback throws twice → falls through to `provision`, no persist-adopt write. **T-adopt-5** persist-on-adopt fails → still returns `{ source: 'adopted' }` (log warn; do not null). **T-adopt-6** callback returns malformed URL (not matching `SMEE_URL_PATTERN`) → treated as null, falls through. **T-adopt-7** persisted file present → adopt tier is NOT called (SC-003 assertion). | FR-002, FR-007, FR-008, FR-010, SC-003 |
| `webhook-setup-service.test.ts` | New tests: **T-find-1** single repo, single smee hook → returns that URL. **T-find-2** single repo, no smee hook → returns null. **T-find-3** multi-repo, both repos have same smee URL → returns URL, no warn. **T-find-4** multi-repo divergence → returns first-repo-first-hook URL, one warn per divergent repo. **T-find-5** `_listRepoWebhooks` throws for one repo → warn+skip, continue to next repo. **T-takeover-1** single Generacy smee hook, URL neither current nor persisted → `update-url` fires. **T-takeover-2** two Generacy smee hooks with stale URLs → no `update-url`, existing `foreign` skip behavior preserved. **T-takeover-3** zero Generacy smee hooks → no `update-url` (`create` path). **T-takeover-4** after adopt fires successfully, the same hook is `current` on the next self-heal → `skip-active` (existing behavior, regression guard). | FR-003, FR-004, FR-005, FR-006, FR-009 |
| `.changeset/1005-adopt-existing-smee-channel.md` | NEW: `patch` bump for `@generacy-ai/orchestrator`. Internal observability + wiring behavior; no public API surface change. | CI gate (CLAUDE.md changeset rule) |

## Constitution Check

No `.specify/memory/constitution.md` present. Applied CLAUDE.md guardrails:

- **Changeset required.** `.changeset/1005-adopt-existing-smee-channel.md`, `patch` for `@generacy-ai/orchestrator`. Not test-only.
- **Package boundary.** All edits in `packages/orchestrator/`; no cross-package additions, no re-exports.
- **No new env vars, no feature flags.** The adopt tier is unconditional; there is no way for it to break the persisted-file fast path (adopt only runs when persisted is absent, guarded by tier order).
- **Fail-open discipline preserved.** Every new failure mode folds into `null` and falls through — the resolver's existing safety-net contract (`smee-channel-resolver.ts:1-10`) is honored.
- **No SmeeWebhookReceiver / monitor changes.** Fix is contained to resolver + webhook-setup service; no touching of event fan-out or poll cadence.
- **No changeset for cluster-base / cloud.** The immediate unblock of an already-orphaned webhook on a currently-stuck cluster is called out in the spec as an ops action, explicitly out of scope here.
- **Idempotency.** After the fix ships, a second boot on the same cluster hits the persisted tier — the adopt tier is skipped (SC-003), no extra GitHub calls.

## Key Technical Decisions

1. **Tier order: persisted before adopt.** Adopt only fires when persisted is missing. A normal `docker restart` (volume intact) still short-circuits at the persisted tier and pays zero extra GitHub calls (FR-010, SC-003). This is the load-bearing decision for the healthy-restart perf guarantee.
2. **URL-prefix-only identifier for "Generacy-owned".** Locked by Q1 → A. Matches the current `foreign` classifier at `webhook-setup-service.ts:498-504`, requires no create-side coordination, and — crucially — catches pre-existing orphaned hooks that predate any marker. A marker convention is called out as a future-facing safety net but is not a dependency of this fix.
3. **First-repo-first-hook wins on multi-repo divergence.** Locked by Q2 → A. Deterministic (iteration matches configured `repos` order), avoids the trap of refusing to adopt (which would re-orphan every repo). Losing repos converge on the next self-heal via the (B) take-over branch, which repoints exactly-one stale hook per repo onto the current channel.
4. **Bail on ≥2 Generacy smee hooks per repo for take-over.** Locked by Q3 + Q5 → A/C. Repointing multiple hooks to one channel causes GitHub to deliver duplicate events → duplicate `Processing … source=webhook` per label change — the exact double-processing failure SC-004 asserts against. Bailing keeps the extras alive but harmless (dead smee channels have no listener) and defers cleanup to ops.
5. **Bounded retry, then fall through to provision-new.** Locked by Q4 → C. Reuses the resolver's existing `MAX_ATTEMPTS = 2` / `RETRY_DELAY_MS = 1000` constants for consistency. Transient GitHub 403 (token refresh mid-flight) or network blips are the common failure mode and retry clears them. Falling through on persistent failure is safe because take-over (B) will heal the resulting single-orphan on the next self-heal pass.
6. **Persist-on-adopt is best-effort.** If `writePersistedFile` fails after a successful adopt, the resolver still returns `{ source: 'adopted' }` — the next boot just re-runs the adopt tier. This diverges from the existing `provisioned` branch, which returns `null` on persist failure (`smee-channel-resolver.ts:97-105`) to avoid orphaning a freshly-provisioned channel. For adopt there is no fresh channel to orphan — the hook already exists on the repo pointing at the URL the callback returned — so persist failure is a self-healing miss, not a resource leak.
7. **Reuse `_listRepoWebhooks`, do not add a parallel discovery client.** The existing method already handles the exact GitHub API path, exit-code translation, JSON parsing, and JIT-token env resolution the adopt tier needs. Adding a parallel discovery client would duplicate every one of those code paths and increase the token surface for no benefit.
8. **In-service divergence log lives at `warn`, not `error`.** Multi-repo divergence is a legacy-state signal (leftovers from separate prior clusters), not a bug — the fix converges the state over subsequent self-heal passes. Emitting `error` would generate false alarms in the dashboard's error feed.

## Suggested Next Step

Run `/speckit:tasks` to generate the ordered task list for this plan.
