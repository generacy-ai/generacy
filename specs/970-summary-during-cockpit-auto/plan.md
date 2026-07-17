# Implementation Plan: Cockpit GraphQL rate-limit exhaustion during `/cockpit:auto`

**Feature**: Reduce cockpit's GraphQL point spend during `/cockpit:auto` runs so a single shared-token operator doesn't exhaust the 5 k/hr GraphQL bucket. Six coordinated fixes at the cockpit CLI + `GhCliWrapper` layer: lifecycle-gate `getPullRequestCheckRuns`, add a short-TTL read-through cache for the three hot GraphQL calls, make `resolveEpic` refresh every Nth cycle only, add a rate-limit probe with unified proactive-widening + reactive-backoff scheduling, and suppress the immediate post-catch-up double poll. The dual poll collapse (root cause #1) is deferred to the agency companion — this plan does not touch it.
**Branch**: `970-summary-during-cockpit-auto`
**Status**: Complete

## Summary

The GraphQL exhaustion has six root causes ranked by spec. This plan lands the five that live in this repo:

1. **Check-run lifecycle gate (FR-002 / Q1=D)** — `runOnePoll` currently calls `getPullRequestCheckRuns` for every PR every cycle. Add a `derivePrChecksNeeded()` sibling to `derivePrLifecycle()` in `packages/generacy/src/cli/commands/cockpit/watch/pr-state.ts`. Terminal-green = every `CheckRunSummary.state ∈ {SUCCESS, SKIPPED, NEUTRAL}` and zero `PENDING`. Skip re-fetch unless (a) `lifecycle` transitioned to `open` from unknown, (b) `headRefOid` changed (new field on `PrSnapshot`), (c) the label set changed, or (d) `cyclesSinceLastCheckFetch >= 20`. Merged/closed PRs never re-fetched. `headRefOid` requires a one-time `gh pr view --json headRefOid,...` — folded into the same `getPullRequest` call that already exists for lifecycle disambiguation, plus a preload the first time we observe a PR.

2. **Short-TTL read-through cache (FR-004 / Q3=A)** — new `packages/cockpit/src/gh/cache.ts` wrapping `getPullRequestCheckRuns`, `getIssue` (and its `--json closedByPullRequestsReferences` variant `resolveIssueToPR`), and `getPullRequest`. Default TTL 20 s (mid-point of 15–30). Keyed by `(method, repo, number)`. Invalidation is local-only: `addLabel`/`addLabels`/`removeLabel`/`removeLabels`/`mergePullRequest` invalidate the affected keys via a same-process hook. Cache instance held per-`GhCliWrapper` (constructor-injectable for tests + reuse across the watch loop, event bus, and `cockpit_status`). External writes fall through on TTL.

3. **Conditional `resolveEpic` refresh (FR-005 / Q5=A)** — every-Nth-cycle only (N=10, ~5 min at 30 s cadence). Applied at both refresh sites:
   - `packages/generacy/src/cli/commands/cockpit/watch.ts:162` (the CLI watch loop's per-cycle refresh)
   - `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts:409` (the event-bus loop's end-of-cycle refresh)

   Both grow a `cyclesSinceEpicRefresh` counter, refresh only when `cyclesSinceEpicRefresh >= 10`, otherwise reuse the last `ResolvedEpic`. The `runRealCycle` opening branch at `event-bus-registry.ts:368` (where `state.currentResolved == null`) is unchanged — the first resolution always fetches.

4. **Rate-limit-aware scheduling (FR-007 + FR-008 / Q2=B, Q4=C)** — new `packages/cockpit/src/gh/rate-limit-scheduler.ts`. On start and every ~5 min (or after any 403 / `retry-after`), invoke `gh api rate_limit` (does NOT itself consume GraphQL budget). Feed remaining % into a widening ladder: `<20% → 2× base (60 s)`, `<5% → 4× base (120 s)`, hard ceiling `5 min`, reset when `remaining ≥ 30%`. `retry-after` (if present on any `gh` response the wrapper opportunistically inspects via `gh api -i`) is honored exactly. Consumed by the CLI watch loop's `sleep(interval, …)` and the event-bus `runPollLoop`'s `sleep(interval, …)` via a shared `getCurrentIntervalMs()` accessor. Not consumed by `cockpit_status` (one-shot).

5. **Catch-up + immediate-resume double poll fix (FR-006)** — in `event-bus-registry.ts:145-150`, after `catchUpPoll()` and before `resumePoller()`, set a `skipNextCycle` flag on `PauseState`. The next `runPollLoop` iteration checks the flag, clears it, and skips one `runCycle()` invocation (still sleeps the full interval). Preserves the "wake immediately if new events accumulated" property because `catchUpPoll` just ran.

The dual poll collapse (root cause #1) is out-of-scope: `/cockpit:auto` is arms both `cockpit watch` and `cockpit_await_events`; collapsing them requires the agency-side skill change (companion issue `generacy-ai/agency`). Once that lands, this plan's per-loop savings compound.

## Technical Context

- **Language/Version**: TypeScript (ESM, Node >=22)
- **Primary Dependencies**: `zod` (existing — used to validate the `gh api rate_limit` response shape), no new deps
- **Packages touched**: `packages/cockpit/` (wrapper, cache, scheduler), `packages/generacy/` (watch loop, event bus, pr-state gate)
- **Test runner**: Vitest (existing convention in both packages)
- **Storage**: In-process only — cache is a `Map<string, { value, expiresAt }>`; scheduler holds one number. No disk, no shared memory, no cross-process signal.
- **Performance goals**: Reduce cockpit's GraphQL spend during an active `/cockpit:auto` run from ~4–6 k/hr to ≤1.5 k/hr per operator token (SC target lives in spec once populated). This is a headroom target — the fix must not regress event-emission latency beyond ~30 s in the steady state.
- **Constraints**: Must not break `cockpit watch` NDJSON output shape; must not break `cockpit_await_events` MCP contract; must not require any config changes for existing operators.

## Constitution Check

No `.specify/memory/constitution.md` in repo. Skipped.

Existing project conventions honoured:
- **Changeset required** (`.github/workflows/changeset-bot.yml`) — this diff touches non-test files under both `packages/cockpit/src/` and `packages/generacy/src/`. The changeset MUST list both packages. Bump level: `minor` on `@generacy-ai/cockpit` (new public exports: `RateLimitScheduler`, `GhCacheOptions`); `patch` on `@generacy-ai/generacy` (internal behavior change, no CLI surface change).
- **No comments describing WHAT** — helpers named for what they do; `Why:` comments only where the constraint isn't obvious (e.g., "N=10 chosen because `gh issue view` costs one GraphQL point regardless of `--json` selection", "skipNextCycle prevents catch-up + immediate-resume double poll").
- **No new inter-process signal** — cache invalidation, scheduler state, and cycle counters are all same-process. External writes handled by TTL, not by a distributed invalidation mechanism.
- **Vitest, no snapshot fixtures** — matches existing test style in `packages/cockpit/src/__tests__/` and `packages/generacy/src/cli/commands/cockpit/watch/__tests__/`.
- **No `cockpit.repos` regression** — this plan does not touch resolver/config plumbing; the deleted-config surface stays deleted.

## Project Structure

```
packages/cockpit/
  src/
    gh/
      wrapper.ts                             MOD  — construct default cache + scheduler in GhCliWrapper
                                                    ctor; getPullRequestCheckRuns / getIssue /
                                                    resolveIssueToPR / getPullRequest delegate through
                                                    the cache when injected; addLabels / removeLabels /
                                                    mergePullRequest call cache.invalidate() on the
                                                    affected keys before returning.
      cache.ts                               NEW  — GhResponseCache class: read-through cache with
                                                    per-key TTL (default 20 s), same-process
                                                    invalidation API, in-flight-request coalescing
                                                    (so N concurrent misses become one gh call).
      rate-limit-scheduler.ts                NEW  — RateLimitScheduler class: `getCurrentIntervalMs()`,
                                                    `probeNow()` (invokes `gh api rate_limit`),
                                                    `noteRetryAfter(seconds)`, `noteResponse(headers)`.
                                                    Ladder + retry-after logic per Q4=C.
    __tests__/
      gh-cache.test.ts                       NEW  — TTL, key coalescing, invalidate-on-write, expiry.
      rate-limit-scheduler.test.ts           NEW  — ladder thresholds, ceiling, retry-after
                                                    precedence, reset semantics.
      gh-wrapper-cache-integration.test.ts   NEW  — GhCliWrapper.getPullRequestCheckRuns hits cache
                                                    on 2nd call inside TTL; addLabels invalidates
                                                    the paired issue entry.

packages/generacy/
  src/cli/commands/cockpit/
    watch/
      pr-state.ts                            MOD  — new derivePrChecksNeeded() sibling of
                                                    derivePrLifecycle(). Consumes prev PrSnapshot,
                                                    current lifecycle, current labels, headRefOid,
                                                    and a cycle counter; returns
                                                    { fetch: boolean, reason: string }.
      poll-loop.ts                           MOD  — runOnePoll consumes derivePrChecksNeeded(); when
                                                    fetch===false, reuse prev.checksRollup + prev
                                                    headRefOid; when true, fetch + write. Cycle
                                                    counter threaded through PollDeps.
      snapshot.ts                            MOD  — PrSnapshot gains headRefOid?: string and
                                                    cyclesSinceLastCheckFetch: number fields; new
                                                    buildPrSnapshot signature.
      __tests__/
        pr-state-checks-gate.test.ts         NEW  — Q1=D matrix: terminal-green + no signal → skip;
                                                    headRefOid change → fetch; label change → fetch;
                                                    cycle-20 safety → fetch; pending → always fetch.
    watch.ts                                 MOD  — cyclesSinceEpicRefresh counter (start 0, ++ each
                                                    tick, only refresh when >=10). Feed
                                                    scheduler.getCurrentIntervalMs() into sleep().
    mcp/event-bus-registry.ts                MOD  — same cyclesSinceEpicRefresh gate on the
                                                    end-of-cycle resolveEpic refresh (line 409).
                                                    PauseState gains skipNextCycle flag; set in
                                                    the acquire branch after catchUpPoll (~line 148),
                                                    consumed at the top of runPollLoop's while body.
                                                    runPollLoop sleep() uses scheduler interval.
      __tests__/
        event-bus-catchup-skip.test.ts       NEW  — after catchUpPoll+resumePoller, next iteration
                                                    skips runCycle (asserted via runCycle spy).
        event-bus-epic-refresh-cadence.test.ts NEW — resolveEpic invoked only on cycles 1, 11, 21…

specs/970-summary-during-cockpit-auto/
  spec.md                                    (untouched — read-only)
  clarifications.md                          (unchanged)
  plan.md                                    NEW (this file)
  research.md                                NEW
  data-model.md                              NEW
  contracts/
    gh-response-cache.md                     NEW — public interface + invalidation semantics
    rate-limit-scheduler.md                  NEW — ladder + retry-after algorithm
    pr-checks-gate.md                        NEW — derivePrChecksNeeded() decision matrix
  quickstart.md                              NEW

.changeset/
  970-cockpit-graphql-rate-limit.md          NEW — minor for cockpit (new exports),
                                                   patch for generacy (behavior change only).
```

**Structure Decision**: The five in-scope fixes split cleanly between two packages. `packages/cockpit/` owns the shared primitives (cache, scheduler) that both the CLI watch loop AND the MCP event-bus loop consume — this is the single point of leverage that makes cross-loop coalescing (FR-004) work. `packages/generacy/` owns the two loops themselves, the lifecycle gate, and the `resolveEpic` cadence. No new package, no restructuring — the CLI watch and MCP event-bus modules already sit in `packages/generacy/src/cli/commands/cockpit/`.

## Design Overview

### GhResponseCache (`packages/cockpit/src/gh/cache.ts`)

Same-process read-through cache. Keyed by a stable string: `${method}:${repo}#${number}`. Values are typed per-method (four caches or one union-typed cache; contract picks one — see `contracts/gh-response-cache.md`). Default TTL 20 s.

```ts
export interface GhCacheOptions {
  ttlMs?: number;             // default 20_000
  now?: () => number;         // test seam
  logger?: { debug?: (msg: string) => void };
}

export interface GhResponseCache {
  getOrFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T>;
  invalidate(key: string): void;
  invalidatePrefix(prefix: string): void;  // used by mergePullRequest to nuke both PR + issue keys
  size(): number;                          // test-only observability
}
```

**In-flight coalescing**: a second `getOrFetch` for the same key while the first is pending returns the same Promise. Eliminates the same-cycle race where the poll loop and a concurrent `cockpit_status` call race the same `getPullRequestCheckRuns(repo, prNumber)`.

**Invalidation**: called from `GhCliWrapper`:
- `addLabels(repo, n, ...)` / `removeLabels(repo, n, ...)` / `addLabel` / `removeLabel` → invalidate `getIssue:${repo}#${n}`
- `mergePullRequest(repo, n, ...)` → invalidate `getPullRequest:${repo}#${n}`, `getPullRequestCheckRuns:${repo}#${n}`, and (via the linked-issue if known) `resolveIssueToPR:${repo}#${linkedIssue}` when the caller passes it. When the linked issue isn't known, TTL expires the stale mapping within 20 s — Q3=A explicitly accepts this.
- `updateIssueBody(repo, n, ...)` → invalidate `getIssue:${repo}#${n}`
- close/reopen surfaces (currently no dedicated wrapper method; if a caller uses `addLabels` to close via labels, we're covered)

**Not cached**: `listIssues` (already batched, hits `gh search issues` = REST search bucket, distinct from GraphQL budget); `getPullRequestDetail`, `getPullRequestGraphqlDetail` (only used at merge time, once); `fetchIssueLabels`, `fetchIssueState`, `fetchIssueTimeline`, `fetchIssueComments`, `postIssueComment`, `getCurrentUser`, `findOpenPrForBranch`, `prDiffNames`, `prDiffPatch`, `updateIssueBody`, `deleteHeadRef`, `getRequiredCheckNames`, `addAssignees`, `resolveIssueToPRRef` (uses tier-1 graphql; different code path, once-per-merge, not hot-path). Only the four hot-path GraphQL methods flagged in the spec are cached.

### RateLimitScheduler (`packages/cockpit/src/gh/rate-limit-scheduler.ts`)

Owns the current poll interval as a piece of shared state.

```ts
export interface RateLimitSchedulerOptions {
  baseIntervalMs?: number;     // default 30_000
  ceilingMs?: number;          // default 300_000 (5 min)
  probeCadenceMs?: number;     // default 300_000 (5 min while healthy)
  fastProbeCadenceMs?: number; // default 60_000 (when remainingRatio < 0.2)
  runner?: CommandRunner;      // for `gh api rate_limit` — reuses GhCliWrapper's runner
  now?: () => number;          // test seam
  logger?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}

export interface RateLimitScheduler {
  getCurrentIntervalMs(): number;
  probeNow(): Promise<{ remaining: number; limit: number }>;
  noteRetryAfter(seconds: number): void;
  noteResponseHeaders(headers: Record<string, string>): void;  // opportunistic
  start(): void;   // arms the probe timer
  stop(): void;    // clears the probe timer
}
```

**Widening ladder (per Q4=C)**:
- `retry-after` present on any response → interval = clamp(min(retry-after * 1000, ceilingMs)); no ladder step. Ladder resumes on next probe.
- otherwise, on each probe:
  - `remaining / limit >= 0.30` → interval = base (30 s), reset step
  - `remaining / limit < 0.20 && >= 0.05` → interval = 2× base (60 s)
  - `remaining / limit < 0.05` → interval = 4× base (120 s), floor to ceiling if lower
- Hard ceiling: 5 min. Never widen past the ceiling even on repeated low-budget probes.
- Fast-probe cadence (1 min instead of 5 min) engages when `remaining / limit < 0.20`. Returns to slow cadence when back above 0.30.

**Probe cost**: `gh api rate_limit` returns the full rate-limit view (core/search/graphql) at zero GraphQL cost. Assumption #4 in spec confirmed by GitHub docs. Failure to probe (network error, gh not authenticated) logs a warning and keeps the last known interval — never crashes the loop.

**Not consumed by `cockpit_status`**: status is a one-shot; a widened interval doesn't apply. `cockpit_status` still hits the cache (which is the point).

### PR checks lifecycle gate (`packages/generacy/src/cli/commands/cockpit/watch/pr-state.ts`)

New pure function `derivePrChecksNeeded()`. Consumes:
- `prevSnapshot: PrSnapshot | undefined`
- `currentLifecycle: PrLifecycle`
- `currentLabels: string[]`
- `currentHeadRefOid: string | undefined` (from a folded `getPullRequest` call — see below)
- `cyclesSinceLastCheckFetch: number` (tracked on `PrSnapshot`)

Returns `{ fetch: boolean; reason: 'no-prev' | 'lifecycle-flip' | 'head-changed' | 'label-changed' | 'safety-cycle' | 'not-terminal' | 'skip-terminal' }`. Runtime uses only the `fetch` boolean; `reason` is for structured logging + tests.

**Rules (per Q1=D)**:
1. No prev snapshot → `fetch: true, reason: 'no-prev'`
2. `currentLifecycle !== 'open'` (merged/closed) → `fetch: false, reason: 'skip-terminal'`
3. Prev `checksRollup ∈ { 'pending', 'error', 'none' }` → `fetch: true, reason: 'not-terminal'`
4. Prev `checksRollup === 'success'` (or terminal-green rollup — see rollup semantics below):
   - `currentHeadRefOid !== prev.headRefOid` → `fetch: true, reason: 'head-changed'`
   - labels changed (set diff, order-insensitive) → `fetch: true, reason: 'label-changed'`
   - `cyclesSinceLastCheckFetch >= 20` → `fetch: true, reason: 'safety-cycle'`
   - otherwise → `fetch: false, reason: 'skip-terminal'`

**Terminal-green definition (Q1=D)**: The existing `rollup()` in `packages/generacy/src/cli/commands/cockpit/watch/check-rollup.ts` already emits `'success'` iff all check-runs have `state ∈ {SUCCESS, SKIPPED, NEUTRAL}` and none `PENDING`. This matches Q1=D exactly — no rollup change needed. `'success'` IS the terminal-green signal.

**Head-ref-OID acquisition**: Requires a small extension to `getPullRequest` and the `PullRequestSummary` type in `packages/cockpit/src/gh/wrapper.ts` to include `headRefOid`. `derivePrLifecycle`'s existing `gh.getPullRequest` call already covers the "just flipped to closed" case; we extend the JSON field selection to include `headRefOid`. For the "PR was open in prev AND open in curr" case (where `derivePrLifecycle` returns `'open'` without a fetch), we need a first-observation fetch. Two options:
- (chosen) Bundle: on first-observation, `runOnePoll` calls `getPullRequest` once to populate the initial `headRefOid`. Costs one GraphQL point per PR per first-observation.
- (rejected) Skip: treat missing `headRefOid` as "always fetch". Loses the optimization for prev-open PRs.

The bundle-once path adds ~1 call per new PR (once per PR per cluster restart), well under the budget cost of the ~120 unconditional cycles it eliminates.

### `resolveEpic` cadence gate

Both loops track `cyclesSinceEpicRefresh: number` (start 0, ++ each tick, refresh + reset when `>= 10`).

CLI watch loop (`watch.ts:159-172`):
```ts
if (!firstTick) {
  cyclesSinceEpicRefresh += 1;
  if (cyclesSinceEpicRefresh >= 10) {
    cyclesSinceEpicRefresh = 0;
    try {
      currentResolved = await resolveEpic(...);
    } catch { /* warn + continue with stale */ }
  }
}
firstTick = false;
```

Event-bus loop (`event-bus-registry.ts:407-414`, inside `runRealCycle`):
```ts
state.cyclesSinceEpicRefresh += 1;
if (state.cyclesSinceEpicRefresh >= 10) {
  state.cyclesSinceEpicRefresh = 0;
  try {
    state.currentResolved = await resolveEpic(...);
  } catch { /* warn + continue with stale */ }
}
```

The initial resolution at `runRealCycle`'s `if (state.currentResolved == null)` branch remains — first cycle always fetches, regardless of counter.

**Why N=10 not "hash-guarded"**: Q5=A explicitly rejects the "cheap poll" alternative — `gh issue view` costs the same GraphQL point regardless of `--json` field set. There is no cheap change-detection primitive. Only the every-Nth-cycle approach reduces GraphQL spend.

### Catch-up double-poll fix (`event-bus-registry.ts`)

`PauseState` grows one field:
```ts
interface PauseState {
  paused: boolean;
  resumeResolver: (() => void) | null;
  skipNextCycle: boolean;   // NEW
}
```

Set-site (existing `acquireEpicBus` block, ~line 145-150):
```ts
if (wasPaused) {
  await existing.catchUpPoll();
  pauseState.skipNextCycle = true;   // NEW
  existing.resumePoller();
}
```

Consume-site (top of `runPollLoop`'s while body, ~line 342):
```ts
while (!signal.aborted) {
  if (pauseState.paused) {
    await waitForResume(pauseState, signal);
    if (signal.aborted) break;
    continue;
  }
  if (pauseState.skipNextCycle) {   // NEW
    pauseState.skipNextCycle = false;
    await sleep(interval, signal);
    continue;
  }
  try { await runCycle(); } ...
}
```

Note: `pauseState` needs to be reachable from `acquireEpicBus`. The current closure structure only exposes `pausePoller` / `resumePoller` on `Subscription`. Add a `Subscription.markSkipNextCycle: () => void` closure that sets `pauseState.skipNextCycle = true` from the outside without leaking the whole `PauseState`.

## Behavior Matrix

### PR checks fetch decision (FR-002 / Q1=D)

| prev.lifecycle | prev.checksRollup | curr.lifecycle | headOid change | label change | cycles >= 20 | fetch? | reason |
|---|---|---|---|---|---|---|---|
| (none) | (none) | open | n/a | n/a | n/a | ✓ | no-prev |
| open | success | merged | n/a | n/a | n/a | ✗ | skip-terminal |
| open | success | closed | n/a | n/a | n/a | ✗ | skip-terminal |
| open | success | open | ✓ | * | * | ✓ | head-changed |
| open | success | open | ✗ | ✓ | * | ✓ | label-changed |
| open | success | open | ✗ | ✗ | ✓ | ✓ | safety-cycle |
| open | success | open | ✗ | ✗ | ✗ | ✗ | skip-terminal |
| open | pending | open | * | * | * | ✓ | not-terminal |
| open | failure | open | * | * | * | ✓ | not-terminal |
| open | none | open | * | * | * | ✓ | not-terminal |
| open | error | open | * | * | * | ✓ | not-terminal |
| merged | * | merged | n/a | n/a | n/a | ✗ | skip-terminal |
| closed | * | closed | n/a | n/a | n/a | ✗ | skip-terminal |

### Rate-limit scheduler state (FR-007 / Q4=C)

| remainingRatio | retry-after present | current interval | probe cadence |
|---|---|---|---|
| >= 0.30 | no | base 30 s | slow (5 min) |
| < 0.30 && >= 0.20 | no | base 30 s (hysteresis: no widening until <0.20) | slow (5 min) |
| < 0.20 && >= 0.05 | no | 2× base = 60 s | fast (1 min) |
| < 0.05 | no | 4× base = 120 s (cap 300 s) | fast (1 min) |
| any | yes | `min(retry-after * 1000, ceiling)` | fast (1 min); next probe overrides |

Hysteresis: widening triggers at `< 0.20`, reset triggers at `>= 0.30`. Prevents oscillation at boundary.

## Risks and Mitigations

1. **Cache staleness masks a real state change** — 20 s TTL is short enough that any user-visible action (label add, PR merge) surfaces within one poll cycle. Local invalidation covers cockpit-initiated writes. External writes (e.g., a human clicking merge in the UI) surface on TTL expiry. Q3=A explicitly accepts this tradeoff.
2. **PR checks gate skips a legitimately re-run check** — the 20-cycle (~10 min) safety re-fetch bounds this. Head-SHA change catches new pushes. Label change catches operator-driven re-runs (e.g., `/rerun-checks` label bot).
3. **Rate-limit probe fails during sustained network trouble** — scheduler keeps last known interval. Never blocks the poll loop on a failed probe.
4. **Widening pushes event-emission latency past 5 min under sustained pressure** — this is by design. The alternative (keep hammering at 30 s and 403) is worse. Operator sees a widening in structured logs (`rate-limit-scheduler: widened interval to N ms, remaining=X/Y`).
5. **`resolveEpic` refresh gate delays operator scope edits by up to 5 min** — Q5=A explicitly accepts this. Documented in quickstart.md.
6. **`skipNextCycle` races a legitimate wake** — the flag is set inside `acquireEpicBus` while holding the registry map (single-threaded on Node event loop). No lock needed. The flag is consumed exactly once by the immediate-next iteration of `runPollLoop`.
7. **Cache breaks a test that stubs `runner` and expects two calls to produce two results** — cache is constructor-injectable and defaults to a no-cache pass-through when tests construct a bare `GhCliWrapper(runner)` without the cache option. Existing tests continue to pass; new tests opt into the cache.
8. **`headRefOid` field addition breaks a downstream consumer of `PullRequestSummary`** — the field is `?: string`. Existing consumers ignore unknown keys. `Snapshot` shape gains an optional `headRefOid` — grep `PrSnapshot` for consumers; the two snapshot builders + diff/aggregate paths don't destructure this field.

## Testing Strategy

### Unit tests

- `gh-cache.test.ts` (NEW) — TTL boundary (hit at 19 s, miss at 21 s); in-flight coalescing (10 concurrent `getOrFetch` → 1 fetcher invocation); invalidate (immediate miss after invalidate); invalidatePrefix; TTL expiry after invalidate resumes fresh fetches.
- `rate-limit-scheduler.test.ts` (NEW) — ladder table above driven directly; retry-after overrides ladder; ceiling never exceeded; reset semantics at 30% recovery.
- `gh-wrapper-cache-integration.test.ts` (NEW) — `getPullRequestCheckRuns` twice within TTL → one runner call; `addLabels` invalidates paired `getIssue` cache key; `mergePullRequest` invalidates paired `getPullRequestCheckRuns` + `getPullRequest`.
- `pr-state-checks-gate.test.ts` (NEW) — every row of the decision matrix above.
- `event-bus-catchup-skip.test.ts` (NEW) — spy on `runCycle`; drive `acquireEpicBus` → `release` (refcount 0) → `acquire` (refcount 1); assert `runCycle` called exactly once (the catch-up), NOT twice.
- `event-bus-epic-refresh-cadence.test.ts` (NEW) — inject `runCycle` that increments a counter; assert `resolveEpic` called only on ticks 1, 11, 21, 31.

### Integration test (behavior end-to-end)

- `cockpit-graphql-budget.integration.test.ts` (NEW) in `packages/generacy/src/cli/commands/cockpit/__tests__/` — spin up a fake `gh` runner that counts calls per subcommand. Drive one hour of simulated `cockpit watch` at 30 s cadence against a 30-ref, 4-open-PR fake epic. Assert:
  - Baseline (pre-fix): >4000 `gh issue view` + `gh pr checks` calls per hour (regression witness).
  - Post-fix: <1500 calls total per hour.
  - Rate-limit scheduler widens to 60 s when the fake `rate_limit` probe returns `remaining=500/5000`.

## Success-Criteria Traceability

The spec's Success Criteria table is a template placeholder (SC-001 with dummies). Once the spec is populated, tie:
- **Reduce GraphQL calls per hour** → `cockpit-graphql-budget.integration.test.ts` + manual `/cockpit:auto` observation on preview channel (documented in quickstart.md).
- **Cache hit ratio ≥ N%** → `gh-cache.test.ts` size/hit accounting.
- **Poll widens under pressure** → `rate-limit-scheduler.test.ts` ladder test.
- **No dropped events across catch-up boundary** → `event-bus-catchup-skip.test.ts` asserts events emitted by the catch-up survive; the skipped cycle only elides a duplicate poll, not any pending emissions.

## Next Steps

- `/speckit:tasks` to generate task list from this plan.
