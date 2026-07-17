# Tasks: Cockpit GraphQL rate-limit exhaustion during `/cockpit:auto`

**Input**: Design documents from `/specs/970-summary-during-cockpit-auto/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/{gh-response-cache,rate-limit-scheduler,pr-checks-gate}.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which in-scope fix this task belongs to
  - **[F1]** Check-run lifecycle gate (`derivePrChecksNeeded`)
  - **[F2]** Short-TTL read-through cache (`GhResponseCache`)
  - **[F3]** Conditional `resolveEpic` refresh (every-Nth-cycle)
  - **[F4]** Rate-limit-aware scheduling (`RateLimitScheduler`)
  - **[F5]** Catch-up + immediate-resume double-poll fix (`skipNextCycle`)

## Phase 1: Foundational primitives (`packages/cockpit/`)

<!-- The cache and scheduler are pure primitives with no dependency on the wrapper.
     They can be built + tested in parallel before the wrapper is touched. -->

- [X] T001 [P] [F2] Create `packages/cockpit/src/gh/cache.ts` implementing `GhResponseCache`
      per `contracts/gh-response-cache.md`. Public API: `createGhResponseCache(opts?)`
      returning `{ getOrFetch, invalidate, invalidatePrefix, size }`. In-flight coalescing
      (Promise dedup) per I-2. Rejections NOT cached (I-3). Default `ttlMs=20_000`. Test
      seams: `now`, `logger.debug`. No LRU (I-5).

- [X] T002 [P] [F4] Create `packages/cockpit/src/gh/rate-limit-scheduler.ts` implementing
      `RateLimitScheduler` per `contracts/rate-limit-scheduler.md`. Public API:
      `createRateLimitScheduler(opts?)` returning `{ getCurrentIntervalMs, probeNow,
      noteRetryAfter, noteResponseHeaders, start, stop }`. Ladder + hysteresis exactly
      per the contract table (widen at `<0.20`, reset at `>=0.30`; `4×base` at `<0.05`;
      ceiling `300_000`). `probeNow()` shells `gh api rate_limit` via injected runner,
      parses `resources.graphql.{remaining,limit,reset}`, on failure logs warn +
      returns `null` (I-5: never mutates interval). `start()` arms `setInterval` and
      calls `.unref()` when available. Construction-time validation:
      `resetWatermarkRatio > lowWatermarkRatio > criticalWatermarkRatio > 0` and
      `ceilingMs >= baseIntervalMs` (throw with specific message on violation).

- [X] T003 [P] [F2] Add unit tests `packages/cockpit/src/__tests__/gh-cache.test.ts`
      covering: TTL hit at 19s / miss at 21s (I-1), in-flight coalescing (10 concurrent
      `getOrFetch` → 1 fetcher invocation, I-2), rejection not cached (I-3), `invalidate(k)`
      immediate re-fetch (I-4), `invalidatePrefix(p)` removes matching entries only,
      `size()` reflects live count.

- [X] T004 [P] [F4] Add unit tests
      `packages/cockpit/src/__tests__/rate-limit-scheduler.test.ts` covering every row
      of the ladder table in `contracts/rate-limit-scheduler.md` (including the
      hysteresis band `0.20 <= r < 0.30` → previous interval retained), retry-after
      overrides ladder (I-3), ceiling never exceeded (I-2), reset at `r >= 0.30`,
      failed probe leaves interval untouched (I-5), construction-time validation
      throws on inverted watermarks and on `ceilingMs < baseIntervalMs`, `start()`/
      `stop()` idempotent.

## Phase 2: Wire cache + scheduler into `GhCliWrapper`

<!-- Phase boundary: T001+T002 must complete (types + implementations must exist)
     before the wrapper can accept them via constructor. -->

- [X] T005 [F2] Extend `PullRequestSummary` in `packages/cockpit/src/gh/wrapper.ts`
      with optional `headRefOid?: string` (per data-model.md). Update the JSON field
      selection in `getPullRequest`'s `gh pr view --json ...` call to include
      `headRefOid` and populate the returned `PullRequestSummary`. Field is optional
      so older test doubles that don't set it still compile.

- [X] T006 [F2] [F4] Extend `GhCliWrapper` constructor in
      `packages/cockpit/src/gh/wrapper.ts` with third `options?: { cache?:
      GhResponseCache; rateLimitScheduler?: RateLimitScheduler }` parameter. When
      `options.cache` present, delegate the four hot-path GraphQL methods
      (`getPullRequestCheckRuns`, `getIssue`, `resolveIssueToPR`, `getPullRequest`)
      through `cache.getOrFetch` keyed as `${methodName}:${repo}#${number}`. Bare
      `new GhCliWrapper(runner)` MUST retain pre-#970 behavior exactly (no caching,
      no scheduler). Do NOT cache `listIssues`, `getPullRequestDetail`,
      `getPullRequestGraphqlDetail`, `fetchIssueLabels`, `fetchIssueState`,
      `fetchIssueTimeline`, `fetchIssueComments`, `postIssueComment`, `getCurrentUser`,
      `findOpenPrForBranch`, `prDiffNames`, `prDiffPatch`, `deleteHeadRef`,
      `getRequiredCheckNames`, `addAssignees`, `resolveIssueToPRRef` (per plan §Not
      cached).

- [X] T007 [F2] Wire cache invalidation from write paths in
      `packages/cockpit/src/gh/wrapper.ts` (invalidation MUST happen BEFORE the wrapper
      method returns, per contract §Caller responsibilities). Sites:
      - `addLabel` / `addLabels` / `removeLabel` / `removeLabels` (repo, n) →
        `cache.invalidate('getIssue:${repo}#${n}')`
      - `updateIssueBody` (repo, n) → `cache.invalidate('getIssue:${repo}#${n}')`
      - `mergePullRequest` (repo, n) → `cache.invalidate('getPullRequest:${repo}#${n}')`
        AND `cache.invalidate('getPullRequestCheckRuns:${repo}#${n}')` AND, when the
        caller passes a known linked issue, `cache.invalidate('resolveIssueToPR:${repo}#${linked}')`.
        When linked issue unknown, TTL handles it (Q3=A explicitly accepts).
      Guard every site with `if (this.cache) …` so bare-wrapper callers are unaffected.

- [X] T008 [F2] Add integration test
      `packages/cockpit/src/__tests__/gh-wrapper-cache-integration.test.ts`. Cases:
      - Two `getPullRequestCheckRuns(repo, n)` calls within TTL → runner invoked once.
      - `addLabels(repo, n, [...])` invalidates the paired `getIssue:${repo}#${n}` key
        (next `getIssue` re-fetches).
      - `mergePullRequest(repo, n)` invalidates paired `getPullRequest` +
        `getPullRequestCheckRuns` keys.
      - Bare `new GhCliWrapper(runner)` (no options) makes two runner calls for two
        `getPullRequestCheckRuns` invocations (regression witness for the opt-in default).

## Phase 3: PR-checks lifecycle gate in `packages/generacy/` watch loop

<!-- Phase boundary: T005 (headRefOid on PullRequestSummary) must land before the
     gate can read it. -->

- [X] T009 [F1] Extend `PrSnapshot` in
      `packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts` with
      `headRefOid?: string` and `cyclesSinceLastCheckFetch: number` (per data-model.md).
      Update `buildPrSnapshot` (and any siblings that construct `PrSnapshot`) to
      populate both — `cyclesSinceLastCheckFetch` starts at `0`; `headRefOid` comes
      from the `PullRequestSummary` returned by `gh.getPullRequest`.

- [X] T010 [F1] Add pure function `derivePrChecksNeeded` in
      `packages/generacy/src/cli/commands/cockpit/watch/pr-state.ts` per
      `contracts/pr-checks-gate.md`. Signature per contract; decision tree per
      contract §Decision tree (branches 1-8 in exactly the specified order); returns
      `{ fetch, reason }`. Export the `PrChecksNeededReason` union + `PrChecksNeededDecision`
      interface. PURE — no I/O, no logging.

- [X] T011 [F1] Wire `derivePrChecksNeeded` into `runOnePoll` in
      `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts`. Extend
      `PollDeps` with optional `cycleNumber?: number` (per data-model.md). For each
      PR ref: compute the decision using `prevSnapshot`, current lifecycle, current
      labels, `currentHeadRefOid` (from the folded `getPullRequest` call — see below),
      and `prevSnapshot.cyclesSinceLastCheckFetch`. When `fetch===false`, reuse
      `prev.checksRollup` and `prev.headRefOid` and increment `cyclesSinceLastCheckFetch`.
      When `fetch===true`, call `getPullRequestCheckRuns`, refresh `checksRollup`, and
      reset `cyclesSinceLastCheckFetch=0`. On first-observation (no prev snapshot),
      call `getPullRequest` once to populate `headRefOid` (plan §Head-ref-OID
      acquisition — bundle-once path). Log the `reason` at debug for observability.

- [X] T012 [P] [F1] Add unit tests
      `packages/generacy/src/cli/commands/cockpit/watch/__tests__/pr-state-checks-gate.test.ts`
      covering every row of the test matrix in `contracts/pr-checks-gate.md` (rows
      1-13). Assert both `fetch` and `reason` for each row. Row 13 (prev success but
      no prev `headRefOid`) guards I-5 — missing `currentHeadRefOid` never triggers
      `head-changed`.

## Phase 4: `resolveEpic` cadence + scheduler interval in the two loops

<!-- Phase boundary: T002 (scheduler) must exist before loops can consume
     `getCurrentIntervalMs()`. Independent of Phase 3. -->

- [X] T013 [F3] [F4] Apply `cyclesSinceEpicRefresh` gate + scheduler interval in
      `packages/generacy/src/cli/commands/cockpit/watch.ts`. Initialise
      `cyclesSinceEpicRefresh = 0` outside the loop. On each tick after `firstTick`:
      increment, refresh `currentResolved` only when `>= 10`, reset on refresh. On
      refresh failure: log warn + keep the stale `currentResolved` (never throw out
      of the loop). Replace the hard-coded interval passed to `sleep(...)` with
      `scheduler.getCurrentIntervalMs()`. Construct the scheduler once and pass it via
      `WatchDeps` (or construct in the CLI entrypoint alongside the wrapper). Call
      `scheduler.start()` before the loop, `scheduler.stop()` on shutdown.

- [X] T014 [F3] [F4] [F5] Apply three changes in
      `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts`:
      1. **Epic-refresh cadence** — inside `runRealCycle` (~line 407): increment
         `state.cyclesSinceEpicRefresh` and refresh `state.currentResolved` only when
         `>= 10`. The opening `if (state.currentResolved == null)` branch at ~line 368
         is unchanged — first cycle always fetches regardless of counter.
      2. **`skipNextCycle` flag** — add `skipNextCycle: boolean` to `PauseState` (per
         data-model.md). In `acquireEpicBus` after `catchUpPoll()` and before
         `resumePoller()` (~lines 145-150), set `pauseState.skipNextCycle = true`.
         At the top of `runPollLoop`'s while body (~line 342), after the paused check:
         if `pauseState.skipNextCycle`, clear it, `await sleep(interval, signal)`,
         `continue`. Expose the setter as a `Subscription.markSkipNextCycle: () =>
         void` closure so `acquireEpicBus` can flip it without leaking the whole
         `PauseState`.
      3. **Scheduler interval** — replace the hard-coded interval passed to `sleep(...)`
         in `runPollLoop` with `scheduler.getCurrentIntervalMs()`. Construct the
         scheduler alongside the shared `GhCliWrapper` for the event bus and call
         `start()` / `stop()` in the same lifecycle as the bus.

- [X] T015 [P] [F5] Add unit test
      `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/event-bus-catchup-skip.test.ts`.
      Spy on `runCycle`. Drive `acquireEpicBus` → release (refcount 0) → acquire
      (refcount 1 — triggers catch-up + resume). Assert `runCycle` called exactly once
      (the catch-up), NOT twice. Assert events emitted by the catch-up survive the
      skipped cycle (per plan Risk 6).

- [X] T016 [P] [F3] Add unit test
      `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/event-bus-epic-refresh-cadence.test.ts`.
      Inject a `runCycle` that increments a counter; count invocations of `resolveEpic`
      (spy or stub). Assert `resolveEpic` invoked on cycles 1, 11, 21, 31 — and NOT
      on the cycles in between. The first cycle's fetch (the `state.currentResolved
      == null` branch) is expected and covered by cycle 1.

## Phase 5: End-to-end verification

<!-- Phase boundary: All implementation phases (2, 3, 4) must land before the
     integration test can exercise them together. -->

- [X] T017 [F1] [F2] [F3] [F4] [F5] Add integration test
      `packages/generacy/src/cli/commands/cockpit/__tests__/cockpit-graphql-budget.integration.test.ts`.
      Spin up a fake `gh` runner that counts calls per subcommand. Drive one hour of
      simulated `cockpit watch` at 30 s cadence against a fake 30-ref, 4-open-PR epic.
      Assertions:
      - Baseline sanity witness: with cache+scheduler+gate DISABLED (bare
        `GhCliWrapper(runner)`), fake runner sees `>4000` combined
        `gh issue view` + `gh pr checks` calls per hour.
      - Post-fix (cache+scheduler+gate ENABLED): fake runner sees `<1500` combined
        calls per hour.
      - Scheduler ladder: when the fake `gh api rate_limit` probe returns
        `remaining=500/5000` (10%), `scheduler.getCurrentIntervalMs()` returns
        `60_000` (2× base).

- [X] T018 [F1] [F2] [F3] [F4] [F5] Add changeset
      `.changeset/970-cockpit-graphql-rate-limit.md`. Per plan §Constitution Check:
      `@generacy-ai/cockpit` bumps `minor` (new public exports: `GhResponseCache`,
      `createGhResponseCache`, `GhCacheOptions`, `RateLimitScheduler`,
      `createRateLimitScheduler`, `RateLimitSchedulerOptions`, `RateLimitProbeResult`,
      new optional `headRefOid` on `PullRequestSummary`, new `options?` param on
      `GhCliWrapper`). `@generacy-ai/generacy` bumps `patch` (internal behavior
      change, no CLI surface change). Write both entries in the same changeset file.

- [X] T019 [F1] [F2] [F3] [F4] [F5] Run `pnpm --filter @generacy-ai/cockpit test`,
      `pnpm --filter @generacy-ai/generacy test`, and `pnpm typecheck` from the
      repo root. All must pass. Regression check: existing tests that construct
      `new GhCliWrapper(runner)` without the cache/scheduler options continue to
      pass (Risk 7 — cache is opt-in). If any test that mocks `PullRequestSummary`
      destructures `headRefOid`, update the mock (Risk 8 — the field is optional
      but a destructure of a missing key still returns `undefined`, so this is a
      diagnostic check, not a required change).

## Dependencies & Execution Order

**Phase-level dependencies** (sequential):
- Phase 1 → Phase 2: primitives (cache, scheduler) must exist before wrapper wires them.
- Phase 1 (T005) → Phase 3: `headRefOid` field on `PullRequestSummary` must exist
  before the gate reads it.
- Phase 1 (T002) → Phase 4: scheduler must exist before loops consume its interval.
- Phase 2, 3, 4 (any order) → Phase 5: integration test needs all fixes wired end-to-end.

**Parallel opportunities within phases**:
- **Phase 1**: T001, T002, T003, T004 are all `[P]` — cache and scheduler are
  independent modules; tests can be written alongside implementation.
- **Phase 2**: T005 → T006 → T007 → T008 are strict sequence (all edit or exercise
  `wrapper.ts` and depend on the previous step).
- **Phase 3**: T009 → T010 → T011 are sequential (snapshot type → pure function →
  wire-through). T012 is `[P]` — depends only on T010 (the pure function), can be
  authored alongside T011.
- **Phase 4**: T013 and T014 both edit loop code but in different files, so they can
  run in parallel once T002 lands. T015 and T016 are `[P]` — different test files,
  different subsystems.
- **Phase 5**: T017 runs after all implementation. T018 (changeset) and T019 (test
  run) can run in parallel with T017 once implementation is complete, but the test
  run (T019) is the final gate.

**Cross-fix independence**:
- F1 (checks gate), F2 (cache), F4 (scheduler) each stand alone — any one can ship
  without the others and still improve the GraphQL budget.
- F3 (epic-refresh cadence) and F5 (skipNextCycle) both live in the two loops
  (`watch.ts` and `event-bus-registry.ts`) and are naturally bundled with F4 (the
  scheduler consumer in the same files), so land them together.

## Notes

- **Playbook coupling**: none. No `packages/claude-plugin-cockpit/commands/*.md` files
  are referenced in `spec.md` or `plan.md`. No `playbook-verification.test.ts` re-pin
  task required.
- **Dual-poll collapse (root cause #1)**: NOT in this plan. Tracked in the
  `generacy-ai/agency` companion. Once landed, per-hour GraphQL cost roughly halves
  again on top of this plan's baseline.
- **Constitution / conventions honoured** (from plan §Constitution Check):
  changeset lists both packages; no comments describing WHAT; no new inter-process
  signal; Vitest without snapshot fixtures; no `cockpit.repos` regression (this plan
  does not touch resolver/config plumbing).
