# Feature Specification: ## Summary

During `/cockpit:auto` test runs (preview channel, local dev cluster) the GitHub **GraphQL** rate limit (5,000 points/hr) is intermittently exhausted

**Branch**: `970-summary-during-cockpit-auto` | **Date**: 2026-07-17 | **Status**: Draft

## Summary

## Summary

During `/cockpit:auto` test runs (preview channel, local dev cluster) the GitHub **GraphQL** rate limit (5,000 points/hr) is intermittently exhausted. Root cause is a large volume of redundant GraphQL-backed `gh` calls in the cockpit poll/status path, with no rate-limit awareness, backoff, or result caching. The cluster + operator + workers all share one account's 5k/hr budget, so cockpit's own inefficiency is what tips it over during check/PR activity bursts.

## Mechanism

The cockpit `GhWrapper` shells out to the `gh` CLI. The subcommands used in the hot path — `gh issue view`, `gh pr view`, `gh pr checks` (the `--json` variants) — are served by GitHub's **GraphQL** API and consume the 5k/hr GraphQL points bucket. (`gh search issues` is the exception — REST `/search/issues`, separate 30/min bucket — so search is not the GraphQL culprit, though it can independently 403 on the search limit.)

## Root causes (ranked by impact)

### 1. Two independent poll loops run against the same epic simultaneously
`/cockpit:auto` arms **both** a `generacy cockpit watch` subprocess (as a Monitor doorbell) **and** `cockpit_await_events` (whose event-bus registry spins up its own poll loop). Both call `runOnePoll` + `resolveEpic` every 30s, independently, neither aware of the other — a flat 2× on all background polling.
- Watch loop: `packages/generacy/src/cli/commands/cockpit/watch.ts:159-222`
- Event-bus loop: `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts:335-415`
- (Agency companion issue tracks the skill-side half — see cross-link below.)

### 2. `cockpit_status(json=true)` re-check fires on every actionable event and is the heaviest call in the system
The auto loop re-checks live state via `cockpit_status` on every dispatched event. Each status call (`packages/generacy/src/cli/commands/cockpit/status.ts:106-156`) does, per ref:
- `resolveIssueToPR` for every **non-PR** issue → a `gh issue view` (GraphQL) — one per child issue, every call
- `getPullRequestCheckRuns` for every PR → `gh pr checks` (GraphQL)

A 30-ref epic ≈ 30+ GraphQL calls **per status call**, and a coalesced batch of K events fires it K times. Likely the largest consumer during active processing.

### 3. Check-runs are polled unconditionally for every PR, including terminal ones
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

## Proposed fixes (in priority order)
- [ ] **Collapse the dual poll** — feed both the Monitor doorbell and the event bus from a single poll loop (or have the skill drop the separate `cockpit watch` and rely on a doorbell the event bus exposes). Eliminates a flat 2×. *(Cross-repo — see agency companion.)*
- [ ] **Gate check-run polling by PR lifecycle** — skip merged/closed PRs; skip already-terminal-green PRs unless a head-SHA/label change is observed. Mirror the existing D5 optimization in `pr-state.ts`.
- [ ] **Add a short-TTL (~15–30s) shared cache** for `pr checks` / `issue view` / `resolveIssueToPR`, keyed on repo+number, shared across the poll loops and `cockpit_status`, to collapse near-simultaneous redundant fetches.
- [ ] **Make `resolveEpic` refresh conditional** — only when the epic body hash changes (or every N cycles) rather than every cycle.
- [ ] **Add rate-limit backoff** — read `x-ratelimit-remaining` / `retry-after` and widen the poll interval as the budget drains.
- [ ] **Fix the catch-up double poll** — suppress the immediate post-resume `runCycle` when a `catchUpPoll` just ran.

## Notes
- Observed on preview channel, local dev cluster, shared `christrudelpw` token.
- Diagnosis only; no fix applied yet.
- Companion (skill-side): generacy-ai/agency — `/cockpit:auto` arms the redundant second poll loop.


## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
