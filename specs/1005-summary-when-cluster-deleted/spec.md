# Feature Specification: ## Summary

When a cluster is deleted and a new one is launched for the same repo (common with our **serial, one-active-cluster-per-repo** model where clusters churn often), the new cluster provisions a brand-new smee channel and **orphans the existing GitHub webhook**

**Branch**: `1005-summary-when-cluster-deleted` | **Date**: 2026-07-19 | **Status**: Draft

## Summary

## Summary

When a cluster is deleted and a new one is launched for the same repo (common with our **serial, one-active-cluster-per-repo** model where clusters churn often), the new cluster provisions a brand-new smee channel and **orphans the existing GitHub webhook**. GitHub keeps delivering to the dead channel, the new cluster listens on a different one, and the label monitor silently degrades to its **5-minute polling fallback** — so labeled issues that should be actioned near-instantly sit for minutes.

## Impact / symptom

Freshly (re)launched cluster: issues with process labels are picked up on the ~5-minute poll cadence instead of immediately via smee. Observed on a `snappoll` relaunch — two issues with `implementation-review` labels weren't processed until ~10 min after launch, all via `source:"poll"`.

## Evidence (orchestrator logs, snappoll relaunch)

```
19:59:51.041  Provisioned new smee channel URL   channelUrl=https://smee.io/YhTe27nFUS5Epw  source=provisioned
19:59:51.135  Connected to smee.io channel
19:59:51.137  Smee receiver connected — monitors flipped to webhook mode   basePollIntervalMs=300000
19:59:51.431  [warn] Foreign webhook present; not modifying   webhookId=654449679  foreignUrl=https://smee.io/6q7OGtl1damwUMts
...
20:09:59  Processing resume label event   issueNumber=4  parsedName=implementation-review  source=poll   (~10 min after launch)
```

The repo webhook (`654449679`) still points at the **previous** cluster's channel (`6q7OGtl1damwUMts`), while the new cluster listens on a freshly provisioned `YhTe27nFUS5Epw`. PR-review poll events land exactly 5 min apart (19:59 → 20:04 → 20:09), confirming polling-only.

## Root cause

1. `SmeeChannelResolver.resolve()` has tiers **preset → persisted-file → provision-new** and **no tier that inspects the repo's existing webhook**. On delete→relaunch the persisted file is wiped with the volume, so it provisions a new channel. — `packages/orchestrator/src/services/smee-channel-resolver.ts`
2. `WebhookSetupService` then classifies the surviving webhook as **foreign** (its URL matches neither the current nor the persisted channel) and leaves it untouched — the designed self-heal (`update-url` when the hook matches the *persisted* channel) can't fire because the persisted channel didn't survive the delete. — `packages/orchestrator/src/services/webhook-setup-service.ts:494-507`

## Proposed fix

**(A) Adopt-existing tier (primary).** Add a resolver tier that queries the repo's webhooks and, if a Generacy `smee.io` hook already exists, **reuses that channel URL** (and persists it so the next boot short-circuits at the persisted tier). Place it **between persisted-file and provision-new**:

1. `env-or-yaml` preset
2. persisted file
3. **NEW: adopt existing repo smee webhook channel**
4. provision new

Rationale for the placement: a normal `docker restart` still hits the persisted file first (no extra GitHub call, common path unchanged); the hook query runs only when persisted is absent — i.e. a fresh/deleted cluster, exactly when the orphan arises. The new cluster then listens on the same channel GitHub already delivers to → instant delivery, zero orphaned webhooks, no webhook write required.

**(B) Serial-model take-over (hardening).** Now that one-active-cluster-per-repo is confirmed, a Generacy `smee.io` hook pointing at a *stale* channel should be **repointed** (`update-url`) to the cluster's channel rather than abandoned as `foreign`. Belt-and-braces for cases (A) doesn't catch. Keep the guard for genuinely non-smee/operator webhooks.

## Scope / files (generacy repo, `@generacy-ai/orchestrator`)

- `packages/orchestrator/src/services/smee-channel-resolver.ts` — new tier + injected `discoverExistingChannel?()` callback + `'adopted'` source; persist on adopt.
- `packages/orchestrator/src/services/webhook-setup-service.ts` — new `findExistingSmeeChannel(repos)` (reuse existing hook-list + `smee.io` detection); loosen the `foreign` handling for own smee hooks (B).
- `packages/orchestrator/src/server.ts` — construct `WebhookSetupService` before the resolver and wire the callback.
- Changeset (patch).

## Acceptance criteria

- Deleting a cluster and relaunching for the same repo results in the new cluster **reusing the existing smee channel** (log: adopted source) with **no newly-provisioned channel** and **no orphaned webhook**.
- Label events are delivered via smee (webhook mode), not the 5-min poll, within seconds of the relaunch settling.
- A normal `docker restart` (persisted file intact) behaves exactly as today — no extra webhook churn, no extra GitHub API call on the persisted-hit path.
- A genuinely foreign (non-smee / operator) webhook is still left untouched.
- Unit tests cover: adopt-existing tier hit/miss, take-over of a stale Generacy smee hook, and the persisted-hit fast path.

## Context / constraints

- **Concurrency model: serial** (one active cluster per repo; frequent redeploys). smee is a broadcast, so channel reuse is safe here; concurrent same-repo clusters are out of scope (already problematic at the processing layer — per-cluster Redis, no cross-cluster dedup).
- Discovered while investigating the App Config onboarding stall (PR #1003, the non-blocking label-sync change).
- The immediate unblock for an already-stuck cluster (repoint the orphaned hook to the live channel) is a one-time manual/ops action, separate from this fix.

## Clarifications (Batch 1 — 2026-07-19)

Decisions resolved via [clarifications.md](./clarifications.md):

- **Q1 — Generacy-owned smee hook heuristic → A**: URL-prefix-only (`https://smee.io/…`). Any smee.io hook on a Generacy-managed repo is treated as ours for both adopt (FR-003) and take-over (FR-005). No config-shape or name-marker gate is required; a Generacy marker MAY be added on hook-create going forward, but adopt/take-over MUST NOT depend on it (would miss pre-existing orphans this fix targets).
- **Q2 — Multi-repo channel divergence → A**: When configured repos disagree on Generacy smee channel URLs, **first-repo-first-hook wins** (deterministic by configured `repos` order). Log the divergence at `warn`. Convergence of the losing repos onto the adopted channel is left to take-over (FR-005) on subsequent self-heal passes.
- **Q3 — Multiple Generacy smee hooks on the same repo → A**: Adopt the first match; **leave extras in place** (non-destructive). Explicitly forbid repointing multiple hooks to the same channel (would cause GitHub to deliver duplicate events → duplicate processing). One-time ops cleanup of legacy extras is out of scope.
- **Q4 — Adopt-tier failure fallback → C**: On `discoverExistingChannel()` throw/timeout, **retry a bounded number of times** (reuse `MAX_ATTEMPTS = 2`, `RETRY_DELAY_MS = 1000`), then fall through to `provision-new`. Persistent-failure fallthrough is safe because take-over (FR-005) will repoint the surviving single hook onto the freshly-provisioned channel on the next self-heal pass.
- **Q5 — Take-over (B) trigger scope → C**: `update-url`-repoint a Generacy smee hook **only when exactly ONE Generacy smee hook exists on the repo AND its URL is stale** (neither the current cluster's channel nor the persisted URL). Bail out on 0 or ≥2 Generacy smee hooks. Runs at boot and on every self-heal poll. Combined with Q3-A this guarantees the cluster never repoints multiple hooks to the same channel.

## User Stories

### US1: Cluster relaunch preserves near-instant webhook delivery

**As a** cluster operator running the serial one-active-cluster-per-repo model,
**I want** a relaunched cluster to reuse the existing repo smee channel instead of provisioning a new one,
**So that** GitHub label/PR events continue to hit the new cluster in seconds instead of degrading to the 5-minute polling fallback.

**Acceptance Criteria**:
- [ ] After `cluster destroy` + `cluster up` for the same repo, orchestrator logs show `source=adopted` (not `source=provisioned`) for the smee channel URL.
- [ ] The repo's existing GitHub webhook is not orphaned: its URL still matches the channel the new cluster is listening on.
- [ ] Label events arrive in webhook mode (`source=webhook`) within seconds of relaunch, not on the 5-minute poll boundary.

### US2: Normal restart path is unchanged

**As a** cluster operator doing a `docker restart` on a healthy cluster,
**I want** the resolver to short-circuit at the persisted-file tier as it does today,
**So that** we don't pay an extra GitHub API call or churn webhooks on the common no-op restart.

**Acceptance Criteria**:
- [ ] When the persisted channel file is present and valid, the resolver returns at the persisted tier (no `list-hooks` call is issued).
- [ ] No new webhook create / update-url / delete calls fire on the healthy-restart path.

### US3: Operator-installed webhooks are left alone

**As a** repo operator with a pre-existing non-smee (or non-Generacy) webhook on my repo,
**I want** the cluster to leave that webhook untouched,
**So that** cluster deployment doesn't silently break my own integrations.

**Acceptance Criteria**:
- [ ] Webhooks whose URL does not start with `https://smee.io/` are classified `foreign` and never modified.
- [ ] The self-heal path never `DELETE`s any pre-existing webhook.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `SmeeChannelResolver` MUST insert a new `adopt-existing` tier ordered `env-or-yaml preset → persisted file → adopt-existing → provision-new`. | P1 | Placement matters: adopt only runs when persisted is absent (fresh/relaunched cluster). |
| FR-002 | The `adopt-existing` tier MUST call an injected `discoverExistingChannel(repos)` callback and, on hit, persist the returned URL so the next boot short-circuits at the persisted tier. | P1 | Callback source: `WebhookSetupService.findExistingSmeeChannel(repos)`. |
| FR-003 | `WebhookSetupService.findExistingSmeeChannel(repos)` MUST identify Generacy-owned smee hooks using **URL-prefix-only** (`https://smee.io/`) — no config-shape or marker check required. | P1 | Q1-A. Operator-installed smee.io hooks on Generacy-managed repos are considered negligible. |
| FR-004 | When repos disagree on the discovered channel URL, `findExistingSmeeChannel` MUST return the first-repo-first-hook URL and MUST log the divergence at `warn`. | P1 | Q2-A. Iteration order = configured `repos` order. |
| FR-005 | When exactly ONE Generacy smee hook exists on a repo AND its URL is stale (neither the current cluster's channel nor the persisted URL), the self-heal path MUST `update-url` that hook to the current channel. Bail out on 0 or ≥2 Generacy smee hooks per repo. | P1 | Q5-C. Runs at boot and on every self-heal poll. |
| FR-006 | When >1 Generacy smee hook exists on a single repo, the resolver MUST adopt the first match and MUST leave the extras in place. It MUST NOT `update-url` extras onto the adopted channel (avoids duplicate-delivery). | P1 | Q3-A. |
| FR-007 | On `discoverExistingChannel` throw/timeout, the adopt tier MUST retry up to `MAX_ATTEMPTS = 2` with `RETRY_DELAY_MS = 1000`, then fall through to `provision-new`. | P1 | Q4-C. Reuse existing resolver retry constants. |
| FR-008 | When `adopt-existing` fires successfully, the resolver MUST emit `source: 'adopted'` in its result and log at `info`. | P1 | Distinguishable from `preset` / `persisted` / `provisioned` for observability. |
| FR-009 | Non-smee webhooks (URL not starting with `https://smee.io/`) MUST continue to be classified `foreign` and left untouched by both adopt (A) and take-over (B). | P1 | Preserves existing operator-webhook guarantee. |
| FR-010 | The persisted-file fast path (US2) MUST NOT issue a GitHub `list-hooks` call when the persisted channel is present and valid. | P2 | Perf / rate-limit guard for the common restart case. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Time from cluster relaunch to first webhook-mode label event on a repo with a pre-existing orphaned smee hook. | < 30 s (was ~5–10 min via polling). | Log timestamp between `Smee receiver connected` and first `source=webhook` label event on a scripted relaunch. |
| SC-002 | Newly-provisioned smee channels on relaunch of a cluster whose repo already has a Generacy smee hook. | 0 | Grep orchestrator boot logs for `source=provisioned` when a `smee.io` hook was already present pre-boot; must be absent. |
| SC-003 | Extra GitHub API calls on healthy `docker restart` (persisted file intact). | 0 additional `list-hooks` calls vs. today. | GitHub API request count in orchestrator boot logs between today's baseline and the healthy-restart path after the change. |
| SC-004 | Duplicate label-event processing after relaunch. | 0 | Assert single `Processing … source=webhook` per label change under a repo with (post-fix) multiple hooks. |
| SC-005 | Foreign (non-smee) webhooks modified by the cluster. | 0 | Log inspection: no `update-url` / `DELETE` calls against hooks whose URL doesn't start with `https://smee.io/`. |

## Assumptions

- **Serial concurrency model.** One active cluster per repo at any time. smee's broadcast semantics make channel reuse safe under this assumption; concurrent same-repo clusters are out of scope (would require processing-layer dedup that doesn't exist).
- **All smee.io hooks on a Generacy-managed repo are Generacy-owned.** Basis for FR-003 (Q1-A). Operator-installed smee.io hooks on the same repo are considered negligible; if they exist, adopt/take-over will treat them as ours.
- **Existing resolver retry constants (`MAX_ATTEMPTS = 2`, `RETRY_DELAY_MS = 1000`) are appropriate for the adopt tier's GitHub call** (Q4-C). If the resolver's constants diverge from what `WebhookSetupService` uses for its own hook-list calls, reuse the resolver's for consistency at the tier level.
- **Persisted file survival is coupled to volume survival.** `cluster destroy` wipes the volume ⇒ persisted file is gone ⇒ adopt tier will run. `docker restart` preserves the volume ⇒ persisted tier hits ⇒ adopt tier is skipped.
- **Multiple Generacy smee hooks accumulate only as legacy cruft** from pre-fix clusters that never cleaned up on shutdown. Post-fix, relaunches reuse instead of create, so multi-hook state stops growing.

## Out of Scope

- **One-time ops cleanup of legacy multi-hook state.** Repos that today carry >1 Generacy smee hook (Q3-A) are not swept by this change. A separate ops-side script/manual sweep is the fix for accumulated cruft.
- **Concurrent same-repo clusters.** Excluded by the serial-model assumption; would require processing-layer dedup (per-cluster Redis, cross-cluster dedup) that is not planned.
- **Repointing an already-orphaned webhook for a *currently* stuck cluster.** Immediate unblock of the field-observed stuck cluster (per issue evidence) is a one-time manual/ops action, separate from this fix.
- **Writing a Generacy-owned marker onto new hooks at create time.** Recommended as a follow-up (Q1 suggestion) but explicitly not a dependency of this fix; adopt/take-over MUST NOT rely on the marker's presence.
- **Cross-cluster webhook coordination or handoff protocol.** Not needed under the serial model; adopt-existing is the mechanism.

---

*Generated by speckit*
