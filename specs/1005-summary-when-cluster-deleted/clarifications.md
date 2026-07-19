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

**Answer**: **A** — smee.io URL prefix (matches current classifier at `webhook-setup-service.ts:498-504`; a marker would miss the pre-existing orphaned hooks this fix targets, since they predate any marker). Suggest *also* writing a Generacy-owned marker into the hook `config`/`name` at create time going forward for future positive ID — but do not require it for adopt/take-over. Operator-installed smee.io hooks on a Generacy-managed repo are negligible.

---

### Q2: Multi-repo channel divergence
**Context**: FR-003 takes `repos` (plural); the resolver returns a single channel URL. If the cluster is configured for multiple repos and two of them each carry a Generacy smee hook whose URLs point at *different* channels (e.g. leftovers from separate prior clusters), the adopt tier must pick one.

**Question**: When adopt-existing discovers different Generacy smee channels across the configured repos, which URL wins?
**Options**:
- **A**: First-repo-first-hook wins (deterministic order = the order `repos` is configured); log the divergence and defer cleanup of the losing channels to (B)'s take-over on next self-heal.
- **B**: Prefer the channel URL that appears on the **most** repos (majority vote); tie-break by first-repo order.
- **C**: Refuse to adopt when repos disagree (fall through to provision-new); log a warning identifying the divergent set.
- **D**: Other (please describe).

**Answer**: **A** — first-repo-first-hook wins (deterministic by configured `repos` order); log the divergence. The single adopted channel becomes current and take-over (Q5) converges the other repos' hooks onto it over subsequent self-heal passes. (Refusing/provision-new would orphan everything — the opposite of the goal.)

---

### Q3: Multiple Generacy smee hooks on the same repo
**Context**: After several delete→relaunch cycles a single repo may accumulate more than one Generacy smee hook (each pointing at a different dead channel), because prior clusters never cleaned up on shutdown. FR-003 says the discovery returns the **first** matching hook. That resolves the *adopt-what* question but leaves the *cleanup* question open.

**Question**: When >1 Generacy smee hook exists on a single repo at boot, what should the resolver + self-heal do with the extras?
**Options**:
- **A**: Adopt the first match; leave the extras in place (out of scope — matches the "One-time ops repair" out-of-scope bullet).
- **B**: Adopt the first match; delete the extras (repo-hook `DELETE`) as part of the same self-heal pass — treat multi-hook state as a bug the cluster now owns.
- **C**: Adopt the first match; repoint the extras via `update-url` to the adopted channel (leaves the repo with N identical hooks — safe but wasteful).
- **D**: Other (please describe).

**Answer**: **A** — adopt the first match, leave extras in place (non-destructive; matches the "one-time ops repair out of scope" bullet). Extras are dead hooks with no listener (harmless), and once adopt ships, relaunches reuse rather than create, so they stop accumulating — remaining cruft is legacy, best swept by a one-time ops cleanup. Explicitly avoid repointing multiples to one channel (option C): GitHub would then deliver duplicate events → duplicate processing.

---

### Q4: Adopt-tier failure fallback
**Context**: The existing resolver is fail-open — every tier folds failure into `return null` and the caller degrades to polling (per `smee-channel-resolver.ts:1-10` comment). The new adopt tier calls out to GitHub, which can fail transiently (network, 403 during token refresh, rate limit).

**Question**: If `discoverExistingChannel()` throws or times out, what should the adopt tier do?
**Options**:
- **A**: Log-and-fall-through to `provision-new` — matches "always resolve a channel" semantics but re-creates the orphaned-hook scenario this fix is designed to prevent when the GitHub call is only transiently down.
- **B**: Log-and-abort (`return null`) — preserves the fail-open shape of other tiers; cluster boots on polling until the next resolver invocation or webhook self-heal repairs things. Never provisions a channel that would orphan the existing hook.
- **C**: Retry a bounded number of times (e.g. reuse `MAX_ATTEMPTS = 2` / `RETRY_DELAY_MS = 1000`) before falling through to provision-new.
- **D**: Other (please describe).

**Answer**: **C** — retry bounded (reuse `MAX_ATTEMPTS=2` / `RETRY_DELAY_MS=1000`), then fall through to provision-new. Transient failures (network, 403 during token refresh, momentary rate-limit) are the common case and retry clears them, preserving adopt. Falling through on persistent failure is safe because take-over (Q5) repoints the existing single hook onto the freshly-provisioned channel, so we don't re-orphan.

---

### Q5: Take-over (B) trigger scope
**Context**: FR-005 says a Generacy smee hook pointing at a *stale* channel MUST be `update-url`-repointed. `WebhookSetupService._classifyExistingHook` (called both at startup and on every self-heal poll) is the natural site for this. Two questions collapse into one: *when* does (B) apply, and does it fire only when (A) missed?

**Question**: Under what conditions is (B) allowed to `update-url` a Generacy smee hook?
**Options**:
- **A**: Only at boot, and only when the adopt tier (A) did *not* fire (i.e. provision-new happened) — narrow safety net for the "adopt missed the hook" case; won't touch a hook that (A) already adopted.
- **B**: Any time `_classifyExistingHook` runs (boot + every self-heal poll), whenever a smee.io hook exists with a URL that is neither the current cluster's channel nor the persisted URL. Fires unconditionally against every stale Generacy smee hook the cluster encounters.
- **C**: Only when there is exactly *one* Generacy smee hook and its URL is stale (bail out on 0 or ≥2 to avoid clobbering ambiguous states); repeat on every self-heal pass.
- **D**: Other (please describe).

**Answer**: **C** — take-over `update-url` only when exactly ONE Generacy smee hook exists and its URL is stale (neither current nor persisted); bail on 0 or ≥2. Runs at boot and on every self-heal poll. Combined with Q3-A this guarantees we never repoint multiple hooks to the same channel (the duplicate-delivery trap). Self-consistent: after adopt fires, current == the adopted hook's channel, so that hook isn't "stale" and take-over leaves it alone.

**Coupling note**: Q3/Q4/Q5 are chosen as a coherent set. Adopt-first restores delivery on relaunch; take-over heals the single-hook case adopt missed; nothing destructive; and no path ever creates two hooks pointing at one channel. The conservative A/A/C/C picks trade a little leftover cruft for zero risk of clobbering operator hooks or double-processing.

---
