# Feature Specification: ## Summary

The `/cockpit:auto` doorbell can only find the cluster's smee channel through the filesystem or an env var

**Branch**: `988-summary-cockpit-auto-doorbell` | **Date**: 2026-07-18 | **Status**: Draft

## Summary

## Summary

The `/cockpit:auto` doorbell can only find the cluster's smee channel through the filesystem or an env var. `discoverChannelUrl` tries, in order: `COCKPIT_DOORBELL_SMEE_URL` → workspace walk-up → workspace mirror (`/workspaces/.generacy/cockpit/smee-channel`) → cluster-internal file (`/var/lib/generacy/smee-channel`). An operator session that does **not** share the cluster's filesystem — the common case, since `/cockpit:auto` runs outside the cluster containers — hits none of these and falls back to poll, unless the operator manually exports `COCKPIT_DOORBELL_SMEE_URL`.

There shouldn't be a separate doorbell channel variable at all: the doorbell should **reuse the exact channel the orchestrator is already using**, discovered automatically.

## Root cause

[`channel-discovery.ts:85-170`](https://github.com/generacy-ai/generacy/blob/develop/packages/generacy/src/cli/commands/cockpit/doorbell/channel-discovery.ts#L85-L170): all four discovery stages are env/filesystem-based; none is reachable from a non-cluster-filesystem session. The workspace-mirror path (#980) only helps when the operator shares the cluster's `/workspaces`. Verified 2026-07-18: on the snappoll cluster the mirror exists inside the snappoll workspace but not in the operator's devcontainer, so discovery returns null → poll fallback → the `COCKPIT_DOORBELL_SMEE_URL` workaround is currently mandatory.

## Proposed fix

Add an authoritative discovery source that reads the channel from the **registered repo webhook** — literally the same channel the orchestrator registered — via `gh api repos/{owner}/{repo}/hooks`, selecting the hook whose `config.url` matches the smee pattern (`^https://smee\.io/[A-Za-z0-9_-]+$`).

Validated on snappoll (2026-07-18):
```
$ gh api repos/christrudelpw/snappoll/hooks --jq '.[] | {id, url: .config.url, active}'
{"active":true,"id":653871794,"url":"https://smee.io/dE1cyM3QiaPW7J7I"}
```
That URL is exactly the channel the orchestrator's smee receiver connects to.

Properties: operator-reachable (uses the `gh` the doorbell already has), authoritative, always current (no stale mirror), needs no env var or shared volume. One REST call at doorbell **startup** — not per-event — so it adds no polling load. Keep `COCKPIT_DOORBELL_SMEE_URL` as an optional override escape hatch, and make webhook-config discovery the default cross-session path.

Ordering is a clarify point: the webhook config is authoritative and current, so it should likely be preferred over the possibly-stale FS mirror (env override still wins first). Degrade gracefully — if the token lacks `admin:repo_hook` read scope (same scope needed to register the hook) or no smee-pattern webhook exists, fall through to today's FS stages, then to the heartbeat.

## Acceptance criteria

- With no `COCKPIT_DOORBELL_SMEE_URL` and no shared cluster filesystem, the doorbell discovers the orchestrator's channel from the repo webhook config and starts `source=smee`.
- When multiple webhooks exist, the smee-pattern hook is selected; non-smee hooks are ignored.
- Graceful degradation (existing FS/heartbeat fallback) when the token lacks scope or no smee webhook is present — no hard failure.
- Uses only repo access the operator already has; one call at startup, zero per-event cost.
- Changeset included.

## Impact / context

Removes the #980 interim workaround (`export COCKPIT_DOORBELL_SMEE_URL=…`) as a requirement. Pairs with the orchestrator poll-gate fix generacy-ai/generacy#987 — together they make cockpit-auto genuinely webhook-fed end to end. Depends on the webhook being registered (#972, now working).


## User Stories

### US1: Operator runs `/cockpit:auto` without exporting a channel URL

**As an** operator running `/cockpit:auto` on an epic in a devcontainer session that does not share the cluster's filesystem,
**I want** the doorbell to auto-discover the smee channel the orchestrator is already using,
**So that** I don't need the `COCKPIT_DOORBELL_SMEE_URL` workaround and the doorbell reports `source=smee` end-to-end without manual configuration.

**Acceptance Criteria**:
- [ ] With `COCKPIT_DOORBELL_SMEE_URL` unset and no shared cluster filesystem, `discoverChannelUrl` returns the same smee URL that the orchestrator registered on the primary repo's webhook config, and the doorbell startup line records `source=smee`.
- [ ] When the primary repo has no smee-pattern hook but a sibling repo in the resolved ref set does, discovery still succeeds by iterating repos primary-first and stopping on the first match.
- [ ] When the token lacks `admin:repo_hook` scope on every target repo (or no smee-pattern hook exists on any of them), discovery falls through to the existing FS stages, then to the heartbeat fallback — no hard failure, doorbell still starts with a fallback `source=…` line.

### US2: Stale prior webhook does not strangle the doorbell

**As an** operator whose orchestrator has been re-registered (channel URL rotated) leaving a stale disabled webhook alongside the fresh active one,
**I want** discovery to pick the current active hook,
**So that** the doorbell binds to the channel that is actually receiving events, not a dead one.

**Acceptance Criteria**:
- [ ] When a repo has both an inactive stale smee hook and an active current smee hook, discovery returns the active one.
- [ ] When multiple active smee hooks exist, discovery returns the one with the most recent `updated_at`.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `discoverChannelUrl` MUST add a `webhook-config` discovery stage that reads the smee channel from `gh api repos/{owner}/{repo}/hooks` on the target repo(s). | P1 | Reuses the `gh` binary the doorbell already has; no new credentials required. |
| FR-002 | The `webhook-config` stage MUST select the hook whose `config.url` matches `^https://smee\.io/[A-Za-z0-9_-]+$` (the smee URL pattern used by orchestrator's `ensureWebhooks`). | P1 | Non-smee webhooks (e.g. project-management integrations) MUST be ignored. |
| FR-003 | `ChannelDiscoveryInput` MUST accept `targets: Array<{ owner: string; repo: string }>` (pre-parsed by the caller). | P1 | Q3=C — caller (doorbell) already resolves refs via `resolveEpic`/`resolveRefSet`; keeps `channel-discovery.ts` free of ref parsing. Primary-only is expressed as `targets.length === 1`. |
| FR-004 | Discovery stage ordering MUST be: `env (COCKPIT_DOORBELL_SMEE_URL) → webhook-config → workspace walk-up → workspace-absolute (/workspaces/.generacy/cockpit/smee-channel) → cluster-internal file (/var/lib/generacy/smee-channel)`. | P1 | Q1=A — env stays as explicit operator override; webhook-config is authoritative and current (beats a possibly-stale FS mirror); FS stages remain as fallback when webhook-config can't resolve. |
| FR-005 | Tie-break when multiple smee-pattern hooks exist on a single repo MUST be: filter to `active: true`, then sort by `updated_at` descending, take the first. | P1 | Q4=D — defends against stale-hook-alongside-fresh-hook after orchestrator re-registration; both fields are already in the `/hooks` response, deterministic and free. |
| FR-006 | Discovery MUST fall through to the next stage when the `gh api …/hooks` call fails with a scope error (403), the endpoint returns zero smee-pattern hooks, or the `gh` invocation returns non-zero. | P1 | Graceful degradation — no hard failure, existing FS/heartbeat fallback path preserved. |
| FR-007 | Each `webhook-config` stage MUST issue at most one `gh api …/hooks` call per repo per doorbell startup — not per event. | P1 | Zero per-event cost preserved; startup budget bounded by `targets.length` (typically 1). |
| FR-008 | For multi-repo epics with N distinct `{owner, repo}` pairs, the `webhook-config` stage MUST iterate targets primary-first and return the first repo whose hooks yield a match (early-stop). | P1 | Q2=B — cluster registers one webhook per watched repo pointing at the SAME channel via `ensureWebhooks(channelUrl, config.repositories)`, so the primary usually resolves in one call; bounded at ≤N calls. Repos where the token lacks scope are skipped, not fatal. |
| FR-009 | The `webhook-config` `gh api` call MUST have a bounded timeout of 5 seconds; on timeout, the stage logs a warn line (with the target repo) and falls through to the next stage. | P1 | Q5=B — a network call isn't OS-bounded like FS reads; a hang would stall the doorbell's `armed\n` + `source=…` line that agency#437 parses. Caps startup latency, degrades cleanly to FS/poll. |
| FR-010 | The doorbell startup log MUST emit `source=smee` (and the discovered URL prefix / stage name) when webhook-config resolves the channel, so downstream consumers (agency#431/#437) can distinguish it from the FS-mirror path. | P2 | Consistent with the existing `source=…` contract; the specific stage-name string is an implementation detail. |
| FR-011 | The changeset MUST be included in the PR. | P1 | Enforced by CI gate (`.github/workflows/changeset-bot.yml`). |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Operator sessions that do not share the cluster filesystem no longer require `COCKPIT_DOORBELL_SMEE_URL` to reach `source=smee`. | 100% of `/cockpit:auto` invocations against a repo whose orchestrator has registered a smee hook resolve to `source=smee` without env override. | Run `/cockpit:auto` on a fresh epic from the operator devcontainer with `COCKPIT_DOORBELL_SMEE_URL` unset and no shared FS mount; assert the doorbell startup line contains `source=smee`. |
| SC-002 | Discovery adds at most one `gh api …/hooks` call per repo per doorbell startup, zero per-event. | ≤ `targets.length` calls at startup (typically 1); 0 additional calls during event stream. | Instrument the `gh` wrapper (or capture via `NODE_DEBUG`); assert the call count over a doorbell session with N events is ≤ `targets.length`. |
| SC-003 | Graceful degradation: token without `admin:repo_hook` scope MUST NOT crash the doorbell. | Discovery falls through to FS/heartbeat; doorbell still emits a startup line with a fallback `source=…`. | Run `/cockpit:auto` with a token that lacks `admin:repo_hook`; assert exit code 0 and a `source=fallback|heartbeat|fs-*` startup line. |
| SC-004 | Stale prior smee webhook alongside a fresh one does not strangle the doorbell. | Discovery picks the active, most-recently-updated hook. | Fixture: mock `gh api …/hooks` returning one inactive + one active smee hook with different `updated_at`; assert the active newer URL is chosen. |
| SC-005 | `webhook-config` stage never blocks doorbell startup > 5s. | 100% of startups complete within 5s of the webhook-config stage entering (or fall through). | Fixture: mock `gh api …/hooks` to hang; assert the stage times out at ~5s, emits a warn line, and the doorbell reaches `armed\n` via a downstream stage. |

## Assumptions

- The orchestrator registers webhooks via `ensureWebhooks(channelUrl, config.repositories)` in a single, coordinated pass — every watched repo's hook points at the same smee channel URL. Discovery therefore only needs the first matching repo.
- `gh api repos/{owner}/{repo}/hooks` returns hooks in creation order and includes `id`, `config.url`, `active`, and `updated_at` fields. GitHub's REST API contract for these fields is stable.
- The token available to the doorbell (`gh auth token`) either has `admin:repo_hook` read scope (typical operator/PAT case) or falls through cleanly on 403. No new scope grants are being asked of the operator.
- The smee URL pattern is stable at `^https://smee\.io/[A-Za-z0-9_-]+$`. If orchestrator registers a hook pointing at anything else (e.g. a smee-lookalike or a `--target` override), the pattern MUST NOT match — those are treated as non-smee and ignored.
- The doorbell's `resolveEpic`/`resolveRefSet` already returns a well-formed `{owner, repo}` list; discovery does not re-validate ref parsing.
- Primary repo is defined as the repo hosting the epic's tracking issue (`form.ref`'s repo), and appears first in the `targets` array passed to discovery.

## Out of Scope

- Refactoring the four existing FS stages (`walk-up`, `workspace-absolute`, `cluster-file`) — they remain unchanged as fallback paths.
- Cache invalidation for the webhook-config result across the doorbell's lifetime — one call at startup is authoritative for the session (a mid-session channel rotation would require doorbell restart, matching today's behavior for FS-mirror rotation).
- Adding a new `gh` scope or credential-helper integration — discovery uses the same token the operator already has.
- Aggregate multi-repo channel-divergence detection (Q2 option C) — orchestrator's `ensureWebhooks` guarantees a single channel per cluster, so aggregate-consistency validation is unnecessary.
- Reworking the heartbeat/poll fallback path — it stays as the terminal stage when both webhook-config and all FS stages return null.
- Non-smee webhook receivers (e.g. direct-delivery / VPC webhook proxies) — this spec is scoped to the smee URL pattern the orchestrator uses today.

---

*Generated by speckit*
