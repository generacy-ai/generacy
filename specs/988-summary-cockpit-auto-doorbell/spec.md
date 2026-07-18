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

### US1: `/cockpit:auto` picks up the orchestrator's smee channel without shared filesystem or env var

**As an** operator running `/cockpit:auto` from a session that does not share the cluster's filesystem (the common case — the operator's devcontainer, a laptop shell, a Codespace against a remote cluster),
**I want** the doorbell to discover the smee channel URL from the same source the orchestrator did — the registered repo webhook —
**So that** I get `source=smee` real-time delivery by default, without having to `export COCKPIT_DOORBELL_SMEE_URL=…` or mount the cluster's `/workspaces` / `/var/lib/generacy`.

**Acceptance Criteria**:
- [ ] With no `COCKPIT_DOORBELL_SMEE_URL` and no reachable FS mirror, `discoverChannelUrl` returns a result whose `url` matches the smee webhook registered on the target repo and whose `source` is a new `webhook-config` value.
- [ ] `armed\n` sentinel line and the `source=…` stderr signal (agency#431 contract) are preserved unchanged.
- [ ] When the `gh` token lacks the scope to list repo hooks, or no smee-pattern hook is registered, discovery falls through to today's FS stages, then to the poll heartbeat — no hard failure, no thrown exception, no non-zero exit.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Add a new discovery stage `webhook-config` to `discoverChannelUrl` (`packages/generacy/src/cli/commands/cockpit/doorbell/channel-discovery.ts`) that calls `gh api repos/{owner}/{repo}/hooks` and returns the first hook whose `config.url` matches `SMEE_URL_PATTERN`. | P1 | Reuses the existing `SMEE_URL_PATTERN = /^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/`. |
| FR-002 | Extend `ChannelSource` union to include `'webhook-config'`. | P1 | Emitted on the `source=webhook-config` stderr line and returned in `ChannelDiscoveryResult.source`. |
| FR-003 | Extend `ChannelDiscoveryInput` with a `gh` dependency (e.g. `gh?: GhCliWrapper`) and a target-repo selector — either `owner`/`repo` fields or a `refs: string[]` array derived from `form.ref` at the doorbell call-site. | P1 | Passed from `doorbell.ts:375-393` where `deps.gh` is already available. |
| FR-004 | Discovery-stage ordering: (1) env override, (2) `webhook-config`, (3) workspace walk-up, (4) workspace-absolute mirror, (5) cluster-internal file. | P1 | Env override remains first (explicit operator intent wins). Webhook-config is authoritative and current, so it precedes the possibly-stale FS mirror stages — see [NEEDS CLARIFICATION: order confirmed?] in issue text. |
| FR-005 | When multiple webhooks are registered on the repo, select the first one whose `config.url` matches `SMEE_URL_PATTERN`. Non-smee hooks (custom URLs, other services) are ignored, not treated as errors. | P1 | GitHub's `/hooks` endpoint returns hooks in creation order; stability across doorbell restarts is not required as long as *some* smee hook is picked. |
| FR-006 | Graceful degradation on ambient failure modes — all of the following fall through to the next stage instead of throwing, with a single `logger.warn` line: (a) `gh` returns non-zero (auth / scope / offline), (b) `gh` returns 404 (repo not found / no access), (c) no hook matches `SMEE_URL_PATTERN`, (d) `gh` wrapper is not supplied by the caller. | P1 | Mirrors the existing FS-stage warn-and-continue pattern (`onNonEnoentError` / `onMalformed`). |
| FR-007 | Exactly one `gh api …/hooks` call per doorbell startup, per resolved repo. Zero per-event calls. | P1 | Result is captured in `discovery` at `doorbell.ts:381-393` before source selection; no re-query on smee reconnect. |
| FR-008 | Multi-repo epics: [NEEDS CLARIFICATION — pick one repo, query all, or defer?] For single-repo/single-ref epics (the current majority), query the one repo. See Assumptions for the working default. | P2 | Multi-repo epic support is the ambiguity — a `refs: string[]` form suggests iterating, but that spends the "one call at startup" budget per repo. |
| FR-009 | Preserve the `COCKPIT_DOORBELL_SMEE_URL` env-override escape hatch at stage 1. | P1 | Explicit operator intent must remain the highest-precedence signal. |
| FR-010 | Preserve `armed\n` sentinel, `source=…` stderr line, and `--exit-on-epic-complete` / `epic-complete` exit semantics. | P1 | Backward compat with agency#431 / #437 skill parser. |
| FR-011 | Update `discoverChannelUrl` unit tests to cover: (a) webhook-config success, (b) fall-through on `gh` error, (c) fall-through when no smee hook exists, (d) multi-hook scenario with one smee-pattern match, (e) ordering — env still wins over webhook-config, webhook-config wins over FS mirror. | P1 | Existing tests at `channel-discovery.test.ts` are the pattern to extend. |
| FR-012 | Changeset entry added (`patch` — `workflow:speckit-bugfix`, no public API change beyond the internal `ChannelSource` union widening). | P1 | Project CLAUDE.md CI gate. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Doorbell startup on a non-cluster-filesystem operator session, with no `COCKPIT_DOORBELL_SMEE_URL` and a registered smee webhook, resolves `source=smee`. | 100% (down from 0% today, per verified 2026-07-18 snappoll observation). | Manual verification on snappoll cluster from the operator devcontainer — run `/cockpit:auto` and confirm stderr shows `source=smee` (not `source=poll-fallback`). |
| SC-002 | Net-new `gh` / GraphQL calls added by discovery per doorbell session. | ≤ 1 per resolved repo, at startup only. | Static analysis of the discovery path; unit test FR-011 asserts single `gh.api` invocation. |
| SC-003 | Hard-failure rate when the token lacks scope or no smee webhook is registered. | 0. | Unit tests FR-011(b)/(c) — discovery returns `null` and falls through, doorbell continues to FS stages, no thrown exception, no non-zero exit. |
| SC-004 | `armed\n` sentinel and `source=…` line contract regressions. | 0. | Existing doorbell integration tests pass unchanged. |
| SC-005 | Necessity of the `COCKPIT_DOORBELL_SMEE_URL` workaround from #980 for operator sessions on the standard cluster shape. | 0 (workaround becomes optional escape hatch, not requirement). | Update project docs / operator runbook to reflect that `export COCKPIT_DOORBELL_SMEE_URL` is no longer needed by default. |

## Assumptions

- **`gh` wrapper availability**: The doorbell already has `deps.gh` in scope at `doorbell.ts:382` — the guard `if (deps.gh != null || deps.discoverChannel != null)` already predicates discovery on it. Passing it through to `discoverChannelUrl` is a plumbing change, not a new dependency.
- **Target repo derivation**: For the single-repo/single-ref case (the majority today), the target `{owner, repo}` is extracted from `form.ref` (issue/PR/epic URL or `owner/repo#N` form) at the doorbell call site. `discoverChannelUrl` itself stays repo-agnostic — the caller supplies the target.
- **Multi-repo epic default (FR-008 clarify placeholder)**: Working assumption — query only the *primary* repo of the epic (the one hosting the epic tracking issue). Multi-repo webhook aggregation is deferred; if the primary repo has no smee hook but a sibling does, discovery still falls through to FS/poll and does not attempt sibling repos. This may be revisited during `/speckit:clarify`.
- **Ordering rationale (FR-004)**: Webhook-config is preferred over FS mirror because the mirror can go stale (e.g. after the orchestrator re-registers a new smee channel post-restart) while the webhook config is by definition current — it's what the orchestrator will actually deliver to. Env override still wins first because operator intent must override discovery.
- **Selection rule for multiple smee hooks (FR-005)**: The first smee-pattern match wins. If a repo has two smee hooks (unusual — indicates operator misconfiguration or a stale second registration), discovery is non-deterministic across restarts but still yields *some* valid channel. Explicit tie-break logic (e.g. "prefer active" or "prefer most recently updated") is deferred as scope-creep.
- **Cost profile (FR-007)**: One `gh api …/hooks` call per doorbell session. GitHub's REST rate limit (5000/hr) makes this negligible even for aggressive restart loops. Not on the per-event path; unrelated to the #985 GraphQL-quota fix.
- **Scope isolation from #987**: This change is about doorbell input discovery, not orchestrator poll-gate behavior. Both are needed to make cockpit-auto genuinely webhook-fed end to end, but they land independently.

## Out of Scope

- Multi-repo epic webhook aggregation (querying every ref's repo). Deferred pending a real multi-repo epic exercise.
- Automatic smee-webhook *registration* by the doorbell — the doorbell reads existing registrations only. Registration remains the orchestrator's job (#972).
- Removing the `COCKPIT_DOORBELL_SMEE_URL` env var entirely — it stays as an intentional operator escape hatch (spec explicit).
- Removing the workspace walk-up / mirror / cluster-file stages — they remain as fallback for legacy cluster shapes and for local-only sessions where the operator does share the FS.
- Caching the discovery result across doorbell restarts (not needed — one REST call per startup is already zero-cost at practical restart frequencies).
- The paired orchestrator poll-gate fix in generacy-ai/generacy#987 — that's a separate change; this issue depends on #987 for full end-to-end correctness but does not implement it.
- Any change to the smee URL pattern regex or the way the orchestrator selects the channel URL — the doorbell simply reads what the orchestrator registered.

---

*Generated by speckit*
