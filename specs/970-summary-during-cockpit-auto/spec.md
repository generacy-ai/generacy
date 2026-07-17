# Feature Specification: Reduce redundant GitHub GraphQL calls in cockpit poll/status path

**Branch**: `970-summary-during-cockpit-auto` | **Date**: 2026-07-17 | **Status**: Draft
**Issue**: [#970](https://github.com/generacy-ai/generacy/issues/970)
**Workflow**: `workflow:speckit-bugfix`

## Summary

During `/cockpit:auto` test runs (preview channel, local dev cluster) the GitHub GraphQL rate limit (5,000 points/hr) is intermittently exhausted. Root cause is a large volume of redundant GraphQL-backed `gh` calls in the cockpit poll/status path, with no rate-limit awareness, backoff, or result caching. The cluster + operator + workers all share one account's 5k/hr budget, so cockpit's own inefficiency is what tips it over during check/PR activity bursts.

## Mechanism

The cockpit `GhWrapper` shells out to the `gh` CLI. The subcommands used in the hot path — `gh issue view`, `gh pr view`, `gh pr checks` (the `--json` variants) — are served by GitHub's GraphQL API and consume the 5k/hr GraphQL points bucket. (`gh search issues` is the exception — REST `/search/issues`, separate 30/min bucket — so search is not the GraphQL culprit, though it can independently 403 on the search limit.)

## Root causes (ranked by impact)

### 1. Two independent poll loops run against the same epic simultaneously

`/cockpit:auto` arms **both** a `generacy cockpit watch` subprocess (as a Monitor doorbell) **and** `cockpit_await_events` (whose event-bus registry spins up its own poll loop). Both call `runOnePoll` + `resolveEpic` every 30s, independently, neither aware of the other — a flat 2× on all background polling.

- Watch loop: `packages/generacy/src/cli/commands/cockpit/watch.ts:159-222`
- Event-bus loop: `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts:335-415`
- (Agency companion issue tracks the skill-side half — see cross-link below.)

### 2. `cockpit_status(json=true)` re-check fires on every actionable event

The auto loop re-checks live state via `cockpit_status` on every dispatched event. Each status call (`packages/generacy/src/cli/commands/cockpit/status.ts:106-156`) does, per ref:

- `resolveIssueToPR` for every **non-PR** issue → a `gh issue view` (GraphQL) — one per child issue, every call
- `getPullRequestCheckRuns` for every PR → `gh pr checks` (GraphQL)

A 30-ref epic ≈ 30+ GraphQL calls **per status call**, and a coalesced batch of K events fires it K times. Likely the largest consumer during active processing.

### 3. Check-runs polled unconditionally for every PR, including terminal ones

`packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts:96-98` calls `getPullRequestCheckRuns` for every PR every cycle — including merged/closed PRs and PRs already green. Note the asymmetry: `getPullRequest` **is** lifecycle-gated (`packages/generacy/src/cli/commands/cockpit/watch/pr-state.ts:18-28`, "Plan D5: avoid an extra call per cycle for stable PRs") but check-runs never got the equivalent gate. Cost grows as merged PRs accumulate in the epic.

### 4. Redundant epic re-resolution every cycle

Both loops call `resolveEpic` (a `gh issue view` on the epic = GraphQL) at the end of every cycle even though the epic body rarely changes mid-run: `event-bus-registry.ts:409`, `watch.ts:162`. ~120 GraphQL calls/hr/loop of near-pure redundancy.

### 5. Catch-up + immediate-resume double poll on every `await_events` re-acquire

In single-caller auto mode each `cockpit_await_events` call cycles the bus refcount 0→1→0. The 0→1 runs a synchronous `catchUpPoll()` (`event-bus-registry.ts:147-150`), then `resumePoller()` unparks `runPollLoop`, which runs `runCycle()` immediately with no sleep gate — two full poll cycles back-to-back, the second finding nothing new.

### 6. No rate-limit awareness, backoff, or caching anywhere in the path

Nothing inspects `x-ratelimit-remaining` / `retry-after`, backs off as the budget drains, or caches check-run/PR results across the poll loops + status/merge tools. The same PR's checks get fetched independently seconds apart by loop A, loop B, and a status re-check; on exhaustion the loop keeps hammering at a fixed 30s and 403s instead of degrading gracefully. Relevant wrapper methods: `packages/cockpit/src/gh/wrapper.ts` — `getPullRequestCheckRuns` (~L874), `getPullRequest` (~L914), `getIssue` (~L808), `resolveIssueToPR` (~L899).

## Rough budget (1-repo epic, ~26 issues, ~4 open PRs)

- Dual background loops: `2 × 120 cycles × (1 epic-view + 4 checks)` ≈ 1,200/hr, continuous even when idle
- Status re-checks at ~1 actionable event/min: `~60 × (1 + 26 + 4)` ≈ 1,860/hr
- Plus `cockpit_context`, `cockpit_merge`, fixer subagents, and the workers' own `gh pr checks` in validate loops — same shared account

Lands ~4–6k/hr → intermittent GraphQL exhaustion correlating with activity bursts.

## User Stories

### US1: Operator running a long `/cockpit:auto` session without 403s

**As an** operator driving a `/cockpit:auto` session against a multi-issue epic on the preview channel,
**I want** cockpit's poll/status path to stay well under the 5k/hr GraphQL budget while sharing that budget with workers and other tooling,
**So that** my auto run does not intermittently 403 mid-flight, stalling event dispatch and requiring manual restart.

**Acceptance Criteria**:
- [ ] A steady-state idle epic (no PR activity) generates <200 GraphQL points/hr from cockpit's background loops.
- [ ] A 30-ref epic under active processing (~1 actionable event/min) stays below ~2000 GraphQL points/hr from cockpit, leaving budget for workers.
- [ ] When the GraphQL budget nears exhaustion, cockpit widens its poll interval rather than hammering and 403ing.

### US2: Terminal-PR aware polling

**As an** operator watching an epic where most PRs have already merged,
**I want** cockpit to stop re-fetching check runs for merged/closed PRs,
**So that** GraphQL cost stays flat as the epic completes rather than growing with each merged PR.

**Acceptance Criteria**:
- [ ] `getPullRequestCheckRuns` is skipped for PRs whose state is `MERGED` or `CLOSED`.
- [ ] `getPullRequestCheckRuns` is skipped for PRs already terminal-green unless the head SHA or label set changed since last observation.

### US3: Shared cache across concurrent tools

**As a** cockpit developer,
**I want** `pr checks`, `issue view`, and `resolveIssueToPR` results cached briefly and shared between the poll loops and MCP tools like `cockpit_status` / `cockpit_merge`,
**So that** near-simultaneous callers coalesce onto a single GraphQL request instead of firing K duplicates.

**Acceptance Criteria**:
- [ ] Same-key requests within a short TTL (default 15–30s) return a cached response instead of hitting `gh`.
- [ ] Cache is invalidated on write paths (label mutations, merges, etc.) that would make the cached view stale.
- [ ] Cache is shared across the two poll loops and the `cockpit_status` re-check path.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Skip `getPullRequestCheckRuns` for PRs whose state is `MERGED` or `CLOSED`. | P1 | Mirrors D5 optimization already applied to `getPullRequest` at `pr-state.ts:18-28`. |
| FR-002 | Skip `getPullRequestCheckRuns` for PRs already terminal-green unless head SHA or labels changed since last cycle. | P1 | Extends lifecycle gating; must survive across cycles via per-PR state. |
| FR-003 | Introduce a short-TTL shared cache for `getPullRequestCheckRuns`, `getPullRequest`, `getIssue`, `resolveIssueToPR`. | P1 | Keyed on repo+number; default TTL 15–30s; shared across poll loops and MCP tools. |
| FR-004 | Cache invalidation on write paths (label add/remove, merge, close/reopen). | P1 | Prevents stale cache masking the effect of mutations by the same process. |
| FR-005 | Make `resolveEpic` refresh conditional — only when epic body/label hash changes or every N cycles. | P2 | Removes redundant per-cycle epic re-fetches from both loops. |
| FR-006 | Suppress the immediate post-`resumePoller` `runCycle` when a `catchUpPoll` just ran in the same 0→1 transition. | P2 | Fixes the double-poll on `cockpit_await_events` re-acquire. |
| FR-007 | Inspect `x-ratelimit-remaining` / `retry-after` on `gh` responses and widen the poll interval as the budget drains. | P2 | Prefer graceful degradation over 403 loops. |
| FR-008 | On GraphQL 403 due to rate limit exhaustion, back off the poll loop with exponential/`retry-after`-based delay instead of continuing at the fixed 30s cadence. | P2 | |
| FR-009 | Log a structured event when polling cadence changes due to rate-limit pressure (visible in cockpit watch/auto logs). | P3 | Observability so operators see when they are being throttled. |
| FR-010 | Cross-repo: agency companion (see #970 body) collapses the dual poll (`cockpit watch` subprocess + event-bus loop). | P1 | Out of scope for this repo — tracked separately in `generacy-ai/agency`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Idle-epic background GraphQL cost per hour | ≤ 200 points/hr from cockpit's background loops (single-loop assumption) | Instrument `GhWrapper` to count GraphQL-bucket calls; run idle for 1h against a real epic. |
| SC-002 | Active-processing GraphQL cost per hour, 30-ref epic, ~1 event/min | ≤ 2,000 points/hr from cockpit | Same instrumentation; run a live `/cockpit:auto` session and sample. |
| SC-003 | 403 GraphQL rate-limit errors during a full `/cockpit:auto` run | 0 during a nominal preview-channel run when workers stay within their own budget | Grep cockpit + worker logs; confirmed by not observing "API rate limit exceeded" stalls. |
| SC-004 | Redundant GraphQL calls collapsed by cache | ≥ 50% reduction in `getPullRequestCheckRuns` / `getIssue` calls under active processing vs. baseline | Compare instrumentation counters before/after with same workload. |
| SC-005 | Merged-PR `getPullRequestCheckRuns` calls | 0 for PRs in `MERGED`/`CLOSED` state | Instrumentation counter filtered by PR state. |
| SC-006 | Behavior on rate-limit exhaustion | Poll widens to a bounded upper interval (e.g. ≤ 5 min) and recovers when budget replenishes; no tight-loop 403s | Force a low `x-ratelimit-remaining` (test hook) and observe log lines + cadence change. |

## Assumptions

1. The cockpit repo owns fixes for the check-run lifecycle gate, the shared cache, `resolveEpic` conditionality, the double-poll fix, and rate-limit backoff. The dual-poll collapse is skill-side (`generacy-ai/agency`) and out of scope here.
2. A short-TTL (~15–30s) cache is acceptable for the poll/status path — poll cadence is 30s, so a 15s TTL still catches events on the next cycle. If any consumer needs strictly fresh reads it can bypass the cache.
3. Cache is per-process (in-memory), keyed on repo+number. No cross-process cache in v1; both poll loops today run in the same Node process.
4. Rate-limit backoff can rely on `gh`'s exposure of response headers; if `gh` swallows them, a small `gh api /rate_limit` probe on a slower cadence (e.g. every 5 min) is an acceptable fallback.
5. Existing `pr-state.ts` D5 pattern is the right model to follow for FR-001 / FR-002 — mirror its shape rather than reinvent.
6. Instrumentation counters can be added to `GhWrapper` without breaking public API.

## Out of Scope

- Collapsing the dual poll loop (`cockpit watch` subprocess vs. event-bus loop) — requires skill-side changes in `generacy-ai/agency`. Tracked separately.
- Reducing worker-side `gh pr checks` calls (workers have their own polling in validate loops). Out of scope for this issue; will show up in their own budget.
- Migrating `gh` calls off GraphQL onto REST equivalents — the failure mode is redundancy, not choice of API.
- Cross-process/shared cache (e.g. Redis-backed). In-memory per-process cache is sufficient given current architecture.
- Search bucket (`gh search issues`, REST `/search/issues`, 30/min) — separate bucket, separate limit, not the culprit here.

## Notes

- Observed on preview channel, local dev cluster, shared `christrudelpw` token.
- Diagnosis only; no fix applied yet — this spec is the first step toward the fix.
- Companion (skill-side): `generacy-ai/agency` — `/cockpit:auto` arms the redundant second poll loop.

---

*Generated by speckit*
