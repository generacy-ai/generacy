# Feature Specification: Adopt existing smee channel on cluster delete→relaunch

**Branch**: `1005-summary-when-cluster-deleted` | **Date**: 2026-07-19 | **Status**: Draft | **Issue**: [#1005](https://github.com/generacy-ai/generacy/issues/1005)

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

## User Stories

### US1: Operator relaunches cluster and gets instant label delivery

**As a** Generacy operator managing a serial one-active-cluster-per-repo deployment,
**I want** a newly (re)launched cluster to reuse the smee channel GitHub is already delivering to,
**So that** labeled issues and PR events are processed within seconds of relaunch — not stuck on the 5-minute poll fallback.

**Acceptance Criteria**:
- [ ] Deleting a cluster and relaunching for the same repo results in the new cluster **reusing the existing smee channel** (log line indicates `source=adopted`).
- [ ] No new smee channel is provisioned when a Generacy smee webhook already exists on the repo.
- [ ] No orphaned webhook remains on the repo after relaunch settles.
- [ ] Label events are delivered via smee (webhook mode / `source=webhook`), not the 5-min poll (`source=poll`), within seconds of relaunch.

### US2: Normal restart path stays fast and quiet

**As a** Generacy operator restarting a healthy cluster (e.g. `docker restart`),
**I want** the persisted smee channel file to short-circuit resolution as it does today,
**So that** no extra GitHub API call is made on the common restart path.

**Acceptance Criteria**:
- [ ] With the persisted-channel file intact, resolution completes at the persisted-file tier — no repo-hook query occurs.
- [ ] No extra webhook churn (create/update/delete) occurs on the persisted-hit path.

### US3: Foreign (non-Generacy) webhooks stay untouched

**As a** repo administrator running non-Generacy webhooks alongside a Generacy cluster,
**I want** the cluster's webhook self-heal logic to leave non-smee / operator-owned webhooks alone,
**So that** unrelated integrations continue to receive their deliveries.

**Acceptance Criteria**:
- [ ] Webhooks whose URL is not on `smee.io` are classified `foreign` and left untouched.
- [ ] The take-over path (B) applies only to Generacy `smee.io` webhooks pointing at a stale channel.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `SmeeChannelResolver.resolve()` MUST attempt an "adopt-existing" tier between `persisted-file` and `provision-new` that discovers an existing Generacy smee webhook on the configured repos and reuses its channel URL. | P1 | New injected `discoverExistingChannel?()` callback + `'adopted'` source. |
| FR-002 | On successful adopt, the resolved channel URL MUST be persisted to the same file the `persisted-file` tier reads, so the next boot short-circuits without a GitHub call. | P1 | Reuse existing persistence writer. |
| FR-003 | `WebhookSetupService` MUST expose `findExistingSmeeChannel(repos)` that lists repo webhooks and returns the first `smee.io` hook URL matching Generacy's channel pattern. | P1 | Reuse existing hook-list + smee.io detection. |
| FR-004 | On startup, `server.ts` MUST construct `WebhookSetupService` before `SmeeChannelResolver` and wire `findExistingSmeeChannel` into the resolver as the `discoverExistingChannel` callback. | P1 | Construction-order change only. |
| FR-005 | `WebhookSetupService` MUST classify a Generacy `smee.io` webhook pointing at a stale channel as an eligible take-over target and issue `update-url` to repoint it to the current channel. | P2 | Hardening (B); serial model only. |
| FR-006 | Non-smee webhooks (operator-owned, other integrations) MUST continue to be classified `foreign` and left untouched. | P1 | Preserve existing safety guard. |
| FR-007 | The `persisted-file` tier MUST retain priority over the new adopt tier — the persisted-hit path performs no additional GitHub API call. | P1 | Common-path preservation. |
| FR-008 | The PR MUST include a `patch`-level changeset for `@generacy-ai/orchestrator`. | P1 | Bugfix per CLAUDE.md changeset rules. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Post-relaunch smee delivery latency | Label events processed via `source=webhook` within 10s of cluster settling (was ~5–10 min via `source=poll`). | Orchestrator log lines: first post-relaunch label event's `source` field + timestamp vs. "Smee receiver connected" line. |
| SC-002 | Orphaned webhooks after relaunch | 0 orphaned Generacy `smee.io` webhooks on the repo after new cluster settles. | `gh api repos/<owner>/<repo>/hooks` shows exactly one Generacy `smee.io` hook and its URL matches the live cluster's channel. |
| SC-003 | Extra GitHub API calls on the common restart path | 0 additional hook-list calls when `persisted-file` tier hits. | Instrument or mock: `discoverExistingChannel` must not be invoked when persisted file is present. |
| SC-004 | Unit test coverage | Tests cover (a) adopt-existing tier hit, (b) adopt-existing tier miss → provision, (c) take-over of stale Generacy smee hook, (d) persisted-hit fast path skips discovery, (e) foreign non-smee hook untouched. | `pnpm test` in `packages/orchestrator` — all five cases pass. |

## Assumptions

- **Serial concurrency model**: exactly one active cluster per repo at any time. smee is a broadcast, so channel reuse is safe under this assumption; concurrent same-repo clusters are already problematic at the processing layer (per-cluster Redis, no cross-cluster dedup) and are out of scope.
- The existing Generacy smee webhook detection (URL prefix on `smee.io`) is reliable enough to distinguish Generacy hooks from unrelated smee.io hooks a repo owner may have set up manually.
- Persisted-file wipes on volume deletion are the dominant trigger for this bug (delete→relaunch clears `.generacy` volume state).
- GitHub webhook list API latency is acceptable on the fresh-cluster path (one-time cost during first boot after a delete).

## Out of Scope

- **Concurrent same-repo clusters.** The processing layer (per-cluster Redis, no cross-cluster dedup) makes this an unrelated problem; smee channel reuse alone would not make it safe.
- **One-time ops repair of already-stuck clusters.** Manually repointing an orphaned webhook to the live channel is a separate ops action, tracked outside this issue.
- **Cluster-managed webhook lifecycle on cluster deletion.** Actively cleaning up webhooks when a cluster is torn down (vs. adopting on next boot) is a different design and not needed once adopt-existing works.
- **Redesign of `WebhookSetupService.foreign` classification** beyond the narrow serial-model take-over allowance in (B).
- **Non-smee webhook transports** (direct HTTP delivery, alternative relays).

## Scope / files (generacy repo, `@generacy-ai/orchestrator`)

- `packages/orchestrator/src/services/smee-channel-resolver.ts` — new tier + injected `discoverExistingChannel?()` callback + `'adopted'` source; persist on adopt.
- `packages/orchestrator/src/services/webhook-setup-service.ts` — new `findExistingSmeeChannel(repos)` (reuse existing hook-list + `smee.io` detection); loosen the `foreign` handling for own smee hooks (B).
- `packages/orchestrator/src/server.ts` — construct `WebhookSetupService` before the resolver and wire the callback.
- `.changeset/1005-*.md` — `patch`-level changeset for `@generacy-ai/orchestrator`.

## Context / constraints

- **Concurrency model: serial** (one active cluster per repo; frequent redeploys). smee is a broadcast, so channel reuse is safe here.
- Discovered while investigating the App Config onboarding stall (PR #1003, the non-blocking label-sync change).
- The immediate unblock for an already-stuck cluster (repoint the orphaned hook to the live channel) is a one-time manual/ops action, separate from this fix.

---

*Generated by speckit*
