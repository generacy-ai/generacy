# Research: Adopt existing smee channel on cluster delete→relaunch

**Issue**: [#1005](https://github.com/generacy-ai/generacy/issues/1005)
**Branch**: `1005-summary-when-cluster-deleted`

## Problem shape

On `cluster destroy` + `cluster up` for the same repo, the persisted smee-channel file at `/var/lib/generacy/smee-channel` is wiped with the named volume. `SmeeChannelResolver.resolve()` finds no persisted URL and provisions a brand-new channel from `smee.io/new`. Meanwhile the repo's GitHub webhook (created during a previous cluster's boot) still points at the *previous* channel — GitHub keeps delivering to a channel with no listener, and the new cluster listens on a channel with no source. The label monitor falls to its 5-minute poll cadence.

Field evidence: `snappoll` relaunch on 2026-07-19 provisioned `YhTe27nFUS5Epw` while the repo's hook `654449679` still pointed at the previous `6q7OGtl1damwUMts`. Two `implementation-review` issues were processed ~10 minutes later, both via `source: 'poll'` — the resolver's silence about the surviving hook masked a full delivery-path outage.

## Root-cause locations

| Site | Behavior today | Contribution to bug |
|------|----------------|---------------------|
| `packages/orchestrator/src/services/smee-channel-resolver.ts:77-115` | Three tiers: env-or-yaml → persisted → provision. No tier inspects the repo's hooks. | Provisions a new channel every time persisted is missing, guaranteeing an orphaned webhook after every `cluster destroy`. |
| `packages/orchestrator/src/services/webhook-setup-service.ts:494-507` | Classifies any smee.io hook whose URL matches neither `current` nor `persisted` as `foreign` → log-and-skip. | The self-heal path can't repoint the surviving hook because the persisted file (its reference for "our own hook") is gone; the take-over (B) branch this fix adds is the exit. |

## Decisions locked by clarifications

### D1 — Generacy-owned identifier: URL prefix only (Q1 → A)

**Decision.** A GitHub hook whose `config.url` starts with `https://smee.io/` (case-insensitive) is considered Generacy-owned, both for the adopt tier's discovery and for the take-over branch's repoint eligibility. No `config`-shape check, no event-list check, no marker.

**Rationale.** Matches the existing `foreign` classifier at `webhook-setup-service.ts:498-504`, so no vocabulary drift. Catches pre-existing orphaned hooks (which necessarily predate any marker convention). Operator-installed `smee.io` hooks on Generacy-managed repos are considered negligible: smee.io is niche enough that the population of "operator manually integrated smee.io on a repo where a Generacy cluster runs" is empirically zero and remains so under the assumption that Generacy repos are dedicated.

**Alternatives considered and rejected.**

- **B — URL prefix + `config` shape check.** Excludes hand-rolled smee.io hooks with different event lists. Rejected because the false-negative case (an old cluster wrote a hook with a different event list than the current locked set) is *exactly* the case adopt needs to catch: those are our own orphaned hooks from an older version. Adding a config-shape gate would silently drop them.
- **C — URL prefix + marker.** Deterministic, but misses hooks created by any cluster version predating the marker. The population of orphaned pre-marker hooks is unbounded (every cluster ever destroyed carries one), and marker-only would leave every one of them stranded — the opposite of the goal.

**Future-facing.** Adding a Generacy marker to newly-created hooks is a cheap belt-and-braces future step (a canonical `name` string or `config.secret` marker), but adopt/take-over MUST NOT depend on it.

### D2 — Multi-repo divergence: first-repo-first-hook wins (Q2 → A)

**Decision.** `findExistingSmeeChannel(repos)` iterates configured repos in declaration order. First smee.io hook found on the first repo wins. Subsequent repos whose first smee.io hook URL disagrees generate one `warn` log per divergent repo, but do not override the choice.

**Rationale.** The alternative — refusing to adopt when repos disagree (Q2 option C) — orphans every repo instead of just the losing ones, exactly the failure mode this fix targets. Deferring convergence to the take-over branch is cheap: on the next self-heal poll, each losing repo's single-hook-stale case triggers `update-url` to the current channel. Two boot cycles at worst, zero manual intervention.

**Alternatives considered.**

- **B — Majority vote.** Adds complexity for no gain. Majority is meaningless when N=2 (the common case).
- **C — Refuse and provision new.** Would re-create the very "provision new channel while a hook already exists" pattern this fix removes.

### D3 — Multi-hook cleanup: adopt first, leave extras (Q3 → A)

**Decision.** When a single repo has ≥2 Generacy smee hooks (accumulated legacy cruft), the resolver adopts the first match and leaves extras alone. The take-over branch also bails on ≥2 (see D5). No `DELETE`, no bulk `update-url`.

**Rationale.** Repointing multiple hooks to one channel causes GitHub to deliver duplicate events (each hook fires independently), which produces duplicate `Processing … source=webhook` per label change and corrupts the monitor's idempotency (Redis dedup is per-key, not per-hook). SC-004 asserts 0 duplicates. Deleting extras is a destructive action outside the fix's scope — an ops-side sweep is the right home for it.

### D4 — Adopt-tier failure: bounded retry + fall through (Q4 → C)

**Decision.** On `discoverExistingChannel()` throw/timeout, retry once with 1s delay (reusing the resolver's existing `MAX_ATTEMPTS = 2` / `RETRY_DELAY_MS = 1000` constants), then fall through to `provision`.

**Rationale.** Transient failures — network blips, 403 during JIT token refresh, momentary rate-limit — are the common case and clear on retry. Falling through on persistent failure preserves the resolver's fail-open contract (`smee-channel-resolver.ts:1-10`); the resulting orphan is single-hook and gets healed on the next self-heal pass by the (B) take-over branch. Aborting outright (Q4 option B) would leave the cluster on polling until a manual intervention.

**Alternatives.**

- **A — No retry, fall through immediately.** Wastes the adopt-tier's value: a single transient 403 during token refresh at boot would trigger a needless provision and orphan the hook.
- **B — Fall through to `null` (polling only).** Preserves fail-open exactly, but wastes a healthy repo where a new hook could have been provisioned safely.

### D5 — Take-over trigger: single-hook only, boot + self-heal (Q5 → C)

**Decision.** `WebhookSetupService` `update-url`-repoints a Generacy smee hook to the current channel only when exactly one Generacy smee hook exists on the repo AND its URL is neither the current cluster's channel nor the persisted URL. Zero or ≥2 → bail out.

**Rationale.** Combined with D3, this guarantees the cluster never repoints multiple hooks to a single channel (the duplicate-delivery trap). Self-consistent with adopt: after adopt fires, `current == the adopted hook's URL`, so the hook isn't "stale" on the next pass and take-over leaves it alone. Runs both at boot and on every self-heal poll — the take-over branch is a scheduled healer, not a boot-only special case.

## Implementation patterns to reuse

- **`_listRepoWebhooks(owner, repo)`** (`webhook-setup-service.ts:708-751`) — the existing method already handles: `gh api /repos/:owner/:repo/hooks`, JIT `GH_TOKEN` env override via `resolveTokenEnv()`, exit-code translation, JSON parse defense, non-array defense. The adopt-tier discovery reuses this method verbatim — the callback `findExistingSmeeChannel(repos)` is nothing more than a loop over `_listRepoWebhooks` with a smee-prefix filter and a first-hit-wins reducer.
- **Bounded-retry loop with sleep injection** (`smee-channel-resolver.ts:143-179`) — the `provision()` method's retry structure is the template for `runAdoptTier()`. Same constants, same `sleepImpl` injection, same `lastError` bookkeeping.
- **Persisted-file write** (`smee-channel-resolver.ts:181-197`) — reused verbatim for the adopt-on-hit persist step. Failure behavior diverges from `provisioned` (persist failure on adopt is best-effort; on `provisioned` it drops the URL to avoid orphan accumulation) — see plan.md decision #6.
- **DI closure at `startSmeePipeline`** (`server.ts:597-617`) — the existing pattern of passing `sendRelayEvent` and `statusReporter` closures into `WebhookSetupService` is preserved. The only wiring change is hoisting the construction site above the resolver's construction.

## Non-decisions (unchanged by this fix)

- **Poll cadence.** Label-monitor stays at 30s webhook-mode / 5min polling-mode. Unchanged.
- **Number of retries in `provision()`.** Existing 2-attempt retry preserved.
- **`foreign` classification for non-smee URLs.** Non-`smee.io` hooks continue to be `foreign` and untouched. FR-009 explicitly preserves the operator-webhook guarantee.
- **`SmeeWebhookReceiver` fan-out.** Not touched.
- **Cross-cluster coordination.** Not needed — the serial-model assumption (one active cluster per repo) makes broadcast smee channel reuse safe.

## Key sources / references

- `packages/orchestrator/src/services/smee-channel-resolver.ts` — resolver, tier structure, retry constants.
- `packages/orchestrator/src/services/webhook-setup-service.ts` — `_listRepoWebhooks`, `_selectExistingHookForUpdate`, `_updateRepoWebhookConfig`, JIT token env pattern.
- `packages/orchestrator/src/server.ts:597-680` — resolver + `WebhookSetupService` construction sites, onReady closure.
- `packages/orchestrator/src/services/__tests__/smee-channel-resolver.test.ts` — resolver tier test patterns (T1-T17).
- `specs/1005-summary-when-cluster-deleted/spec.md` — canonical FR list and acceptance criteria.
- `specs/1005-summary-when-cluster-deleted/clarifications.md` — Batch 1 answers (Q1-Q5).
- Field-evidence log (spec.md §Evidence) — timestamps of the `snappoll` relaunch showing `provisioned` vs. surviving `foreignUrl`.
