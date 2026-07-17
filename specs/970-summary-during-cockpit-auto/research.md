# Research: Cockpit GraphQL rate-limit exhaustion

## Problem framing

The spec's diagnostic section is exhaustive. This document captures the technology decisions made when translating the six root causes into an implementation plan.

## Decision 1: Cache layer location — `GhCliWrapper` vs. per-loop cache

**Choice**: single cache instance owned by `GhCliWrapper`, injected via constructor, shared across all consumers of the wrapper.

**Rationale**: The CLI watch loop, the event-bus loop, and `cockpit_status` all instantiate their own `GhCliWrapper` today. If we cache per-loop, we get no cross-loop coalescing — and the spec explicitly calls out "the same PR's checks get fetched independently seconds apart by loop A, loop B, and a status re-check". A wrapper-owned cache means the same `GhCliWrapper` shared across loops (via `WatchDeps.gh` / `AcquireOptions.gh`) gets a single cache. Loops that construct their own wrapper still each get their own cache, but at least each loop internally coalesces.

**Alternatives considered**:
- **Module-level singleton** (like `retained-tunnel-event.ts` in #966). Rejected: tests can't sandbox, and the "one operator token" scope is per-`GhCliWrapper` (which is per-process, not per-module). No functional difference for hot path, worse for tests.
- **Cross-process cache (Redis)**. Rejected: this is a CLI process; adding a Redis dep for a 20 s TTL cache is absurd.
- **Read-your-writes bypass** (D from Q3). Rejected by clarification Q3=A: 30 s poll cadence + local-only invalidation is sufficient.

## Decision 2: Cache API shape — generic `getOrFetch` vs. method-specific

**Choice**: generic `getOrFetch<T>(key, fetcher)` on `GhResponseCache`.

**Rationale**: The wrapper methods differ in return shape (`Issue`, `PullRequestSummary`, `CheckRunSummary[]`, `number | null`). A generic API avoids four parallel type-parameterized methods on the cache. The wrapper builds the key string once per call site — cheap, colocated, easy to test.

**Key convention**: `${methodName}:${repo}#${number}`. Prefix invalidation via `invalidatePrefix(':${repo}#${number}')` is not sufficient because the prefix would match other methods too; instead, invalidation calls list the exact keys to invalidate. Kept simple: no LRU eviction, unbounded map, entries expire naturally on TTL. Bounded in practice by `refs × methods` (<1000 keys for a large epic).

**Alternatives considered**:
- **Typed cache per method** (`checksCache`, `issueCache`, `prCache`, `resolvedCache`). Rejected: 4× the boilerplate for no runtime benefit.
- **LRU eviction**. Rejected: TTL is 20 s; no epic is large enough for the cache to grow unbounded within one TTL window.

## Decision 3: Rate-limit signal source — probe vs. response headers

**Choice**: `gh api rate_limit` probe on a 5 min slow cadence (1 min fast when low). Response headers opportunistic.

**Rationale**: Direct quote from clarification Q2=B — "the hot-path calls are `gh pr checks` / `gh issue view`, which do NOT surface response headers in our shell-out model". `gh api rate_limit` is documented as not counting against any bucket. This is the canonical way to poll rate-limit state without a per-response header path.

**Probe cost**: One REST call to `/rate_limit` every ~5 min = 12 calls/hr. Trivial vs. the ~1200/hr the fix removes.

**Alternatives considered**:
- **Response headers only** (A from Q2). Rejected because `gh` doesn't surface them for the hot-path subcommands.
- **`gh api -i` on every hot-path call to capture headers**. Rejected: would require rewriting hot-path subcommands to go through `gh api` instead of `gh pr checks` / `gh issue view` — bigger surface change than adding a probe.
- **Reactive-only (D from Q4)**. Rejected by Q4=C: unified proactive-widening + reactive `retry-after` gives graceful degradation instead of a cliff at exhaustion.

## Decision 4: Widening algorithm — step ladder vs. continuous

**Choice**: single-step ladder (Q4=C) — `<20% → 2×`, `<5% → 4×`, ceiling 5 min, reset at `>=30%`. `retry-after` overrides.

**Rationale**: Step ladders are easier to reason about ("when am I widened?") and easier to test (three discrete states). The continuous form (B from Q4) buys smoother behavior but requires floating-point clamp logic and no operator has ever asked for "smooth". Step ladder + hysteresis is the industry-standard rate-limit response shape.

**Hysteresis**: widen at `<0.20`, reset at `>=0.30`. Prevents flap at the boundary.

## Decision 5: `resolveEpic` cadence — every-N vs. change-detected

**Choice**: every-Nth-cycle with N=10 (~5 min at 30 s base cadence). Q5=A.

**Rationale**: The chicken-and-egg problem in clarification Q5 — you can't detect a change without fetching. Option C ("cheap poll") assumed `gh issue view --json updatedAt` would be cheap, but every `gh issue view` invocation costs one GraphQL point regardless of `--json` field set. Only every-N truly saves GraphQL budget.

**Trade-off**: operator scope edits to the epic body surface up to ~5 min late. Documented in quickstart.md. Skill-side doorbell (D from Q5) is a cross-repo change and not in scope.

## Decision 6: PR checks lifecycle gate — terminal-green definition

**Choice**: Q1=D. Terminal-green = all `state ∈ {SUCCESS, SKIPPED, NEUTRAL}` and none `PENDING`. Re-fetch on `headRefOid` change OR label change OR every 20 cycles.

**Rationale**: The existing `rollup()` function in `check-rollup.ts` already emits `'success'` under this exact definition — no rollup change needed. Q1's option C ("success only, no skipped/neutral") would be stricter but would keep hammering PRs that skip conditional checks. Q1=D matches existing rollup semantics AND the auto skill's merge-time re-verify bounds risk.

**20-cycle safety**: 10 min at 30 s cadence. Catches late-registered required checks without inflating steady-state cost meaningfully — for a 4-open-PR epic, one safety re-fetch per PR every 10 min is 24 calls/hr per PR = ~100/hr across 4 PRs, vs. the ~480/hr the gate removes.

**headRefOid acquisition**: Extend `getPullRequest`'s JSON selection to include `headRefOid`. One `gh pr view` per PR per first-observation, then cached. Not a regression — the existing D5 optimization already calls `getPullRequest` on the lifecycle-flip case; adding a first-observation call is +1 per PR per cluster restart, cheap.

## Decision 7: Catch-up + double-poll fix — flag vs. state machine

**Choice**: single `skipNextCycle: boolean` flag on `PauseState`.

**Rationale**: The observed bug is exactly one-cycle: catch-up runs the cycle synchronously, then `resumePoller` unparks `runPollLoop`, which runs immediately. A one-shot boolean flag matches the one-shot behavior. A state machine is overkill.

**Alternative considered**: track a `lastCycleAt` timestamp and skip if `now() - lastCycleAt < interval`. More general, but adds a wall-clock dependency and doesn't handle test time correctly without a `now()` injection. Boolean is simpler.

## Decision 8: Dual-poll collapse (root cause #1) — deferred

**Not in this plan**. `/cockpit:auto` arms both `cockpit watch` (as a Monitor doorbell) AND `cockpit_await_events`. Collapsing them requires the agency-side skill to drop `cockpit watch` and consume a doorbell exposed by the event bus. That's `generacy-ai/agency` companion work.

**Impact on this plan**: the five in-scope fixes reduce per-loop cost. Once the collapse lands, savings roughly halve again because there's one loop instead of two. Fixes are compatible — no rework needed on the collapse.

## References

- Spec: `specs/970-summary-during-cockpit-auto/spec.md`
- Clarifications: `specs/970-summary-during-cockpit-auto/clarifications.md`
- Existing D5 optimization pattern: `packages/generacy/src/cli/commands/cockpit/watch/pr-state.ts` (the `derivePrLifecycle` lifecycle-gate is the template `derivePrChecksNeeded` mirrors)
- Existing wrapper: `packages/cockpit/src/gh/wrapper.ts` (methods to be cached: `getPullRequestCheckRuns` L874, `getIssue` L808, `resolveIssueToPR` L899, `getPullRequest` L914)
- Event-bus loop: `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` (double-poll site L145-150; epic-refresh site L407-414)
- CLI watch loop: `packages/generacy/src/cli/commands/cockpit/watch.ts` (epic-refresh site L159-172)
- GitHub docs: `/rate_limit` REST endpoint does not consume any bucket; `gh api rate_limit` returns core/search/graphql sections.
