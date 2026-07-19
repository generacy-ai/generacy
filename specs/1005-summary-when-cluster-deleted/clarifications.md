# Clarifications — Adopt existing smee channel on cluster delete→relaunch

**Issue**: [#1005](https://github.com/generacy-ai/generacy/issues/1005)
**Branch**: `1005-summary-when-cluster-deleted`

---

## Batch 1 — 2026-07-19

### Q1: Generacy-owned smee hook heuristic
**Context**: The current `foreign` classifier at `packages/orchestrator/src/services/webhook-setup-service.ts:498-504` uses only `url.startsWith('https://smee.io/')` to flag smee hooks. FR-003 (discover-and-adopt) and FR-005 (take-over of a "stale Generacy smee hook") both need to decide whether a given smee.io hook is *Generacy-owned* vs. an operator's manual smee.io integration. Getting this wrong under (B) means we `update-url` a hook the operator installed themselves.

**Question**: What heuristic identifies a smee.io hook as "Generacy-owned" for purposes of adopt (A) and take-over (B)?
**Options**:
- **A**: URL prefix only (`https://smee.io/…`) — trust the assumption in the spec that any smee.io hook on a Generacy-managed repo is ours; simplest, matches today's classifier.
- **B**: URL prefix **plus** matching hook `config` shape (content-type `json`, events list contains Generacy's subscribed events, and/or a known secret marker). More conservative; excludes hand-rolled smee.io hooks with different event lists.
- **C**: URL prefix **plus** a Generacy-owned marker written into the hook `name` or `config` (e.g. a fixed `name` string) at create time — deterministic but requires a compatible create-side change and misses hooks created by older cluster versions.
- **D**: Other heuristic (please describe).

**Answer**: *Pending*

---

### Q2: Multi-repo channel divergence
**Context**: FR-003 takes `repos` (plural); the resolver returns a single channel URL. If the cluster is configured for multiple repos and two of them each carry a Generacy smee hook whose URLs point at *different* channels (e.g. leftovers from separate prior clusters), the adopt tier must pick one.

**Question**: When adopt-existing discovers different Generacy smee channels across the configured repos, which URL wins?
**Options**:
- **A**: First-repo-first-hook wins (deterministic order = the order `repos` is configured); log the divergence and defer cleanup of the losing channels to (B)'s take-over on next self-heal.
- **B**: Prefer the channel URL that appears on the **most** repos (majority vote); tie-break by first-repo order.
- **C**: Refuse to adopt when repos disagree (fall through to provision-new); log a warning identifying the divergent set.
- **D**: Other (please describe).

**Answer**: *Pending*

---

### Q3: Multiple Generacy smee hooks on the same repo
**Context**: After several delete→relaunch cycles a single repo may accumulate more than one Generacy smee hook (each pointing at a different dead channel), because prior clusters never cleaned up on shutdown. FR-003 says the discovery returns the **first** matching hook. That resolves the *adopt-what* question but leaves the *cleanup* question open.

**Question**: When >1 Generacy smee hook exists on a single repo at boot, what should the resolver + self-heal do with the extras?
**Options**:
- **A**: Adopt the first match; leave the extras in place (out of scope — matches the "One-time ops repair" out-of-scope bullet).
- **B**: Adopt the first match; delete the extras (repo-hook `DELETE`) as part of the same self-heal pass — treat multi-hook state as a bug the cluster now owns.
- **C**: Adopt the first match; repoint the extras via `update-url` to the adopted channel (leaves the repo with N identical hooks — safe but wasteful).
- **D**: Other (please describe).

**Answer**: *Pending*

---

### Q4: Adopt-tier failure fallback
**Context**: The existing resolver is fail-open — every tier folds failure into `return null` and the caller degrades to polling (per `smee-channel-resolver.ts:1-10` comment). The new adopt tier calls out to GitHub, which can fail transiently (network, 403 during token refresh, rate limit).

**Question**: If `discoverExistingChannel()` throws or times out, what should the adopt tier do?
**Options**:
- **A**: Log-and-fall-through to `provision-new` — matches "always resolve a channel" semantics but re-creates the orphaned-hook scenario this fix is designed to prevent when the GitHub call is only transiently down.
- **B**: Log-and-abort (`return null`) — preserves the fail-open shape of other tiers; cluster boots on polling until the next resolver invocation or webhook self-heal repairs things. Never provisions a channel that would orphan the existing hook.
- **C**: Retry a bounded number of times (e.g. reuse `MAX_ATTEMPTS = 2` / `RETRY_DELAY_MS = 1000`) before falling through to provision-new.
- **D**: Other (please describe).

**Answer**: *Pending*

---

### Q5: Take-over (B) trigger scope
**Context**: FR-005 says a Generacy smee hook pointing at a *stale* channel MUST be `update-url`-repointed. `WebhookSetupService._classifyExistingHook` (called both at startup and on every self-heal poll) is the natural site for this. Two questions collapse into one: *when* does (B) apply, and does it fire only when (A) missed?

**Question**: Under what conditions is (B) allowed to `update-url` a Generacy smee hook?
**Options**:
- **A**: Only at boot, and only when the adopt tier (A) did *not* fire (i.e. provision-new happened) — narrow safety net for the "adopt missed the hook" case; won't touch a hook that (A) already adopted.
- **B**: Any time `_classifyExistingHook` runs (boot + every self-heal poll), whenever a smee.io hook exists with a URL that is neither the current cluster's channel nor the persisted URL. Fires unconditionally against every stale Generacy smee hook the cluster encounters.
- **C**: Only when there is exactly *one* Generacy smee hook and its URL is stale (bail out on 0 or ≥2 to avoid clobbering ambiguous states); repeat on every self-heal pass.
- **D**: Other (please describe).

**Answer**: *Pending*

---
