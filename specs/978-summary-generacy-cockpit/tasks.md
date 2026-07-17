# Tasks: Cockpit doorbell subscribes to smee stream (revised FR-011)

**Input**: Design documents from `/specs/978-summary-generacy-cockpit/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1 = revised-FR-011 doorbell (the sole user story in this spec)

## Phase 1: Setup

- [ ] T001 [US1] Add `.changeset/978-cockpit-doorbell-smee.md` with a `patch` bump for
  `@generacy-ai/generacy`. Body: one-line summary of the wake-source swap
  (smee-first, poll-fallback); note that no CLI surface changes and no
  public schemas move (Q1=A preserved). Required by the changeset CI gate
  (`.github/workflows/changeset-bot.yml`) because this diff touches non-test
  files under `packages/generacy/src/`.

## Phase 2: Pure Functions (all parallel — no shared files)

- [ ] T010 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/doorbell/channel-discovery.ts`
  exporting `discoverChannelUrl(input: ChannelDiscoveryInput): Promise<ChannelDiscoveryResult | null>`
  per `contracts/channel-discovery.md` and `data-model.md` § ChannelDiscoveryInput/Result.
  - Constants: `DEFAULT_CHANNEL_FILE_PATH = '/var/lib/generacy/smee-channel'`,
    `SMEE_URL_PATTERN = /^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/` (copy verbatim from
    `packages/orchestrator/src/services/smee-channel-resolver.ts:27` — do not import
    across packages).
  - Precedence: env `COCKPIT_DOORBELL_SMEE_URL` first, then `fs.readFile(channelFilePath, 'utf-8')` trimmed.
  - Failure behavior: never throws. Malformed values or non-ENOENT read errors
    emit one `logger.warn` and fall through. ENOENT is silent.
  - Return `null` when no tier produces a `SMEE_URL_PATTERN`-matching URL.

- [ ] T011 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/doorbell/sse-parser.ts`
  exporting `parseSseEventBlock(text: string): NormalizedPayload | null` per
  `data-model.md` § NormalizedPayload.
  - Pair `event:` and `data:` lines from a single SSE frame block.
  - Multi-line `data:` fields joined per SSE spec (concat with `\n`).
  - Ignore `ready` and `ping` frames (return `null`) — matches
    `packages/orchestrator/src/services/smee-receiver.ts` inline parser.
  - Extract `x-github-event` at top level of the parsed JSON, `body.action`, `body`.
  - Malformed JSON → `null` (silent).

- [ ] T012 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/doorbell/webhook-to-event.ts`
  exporting `webhookToStreamEvent(githubEvent, action, body, refSet, now): CockpitStreamEvent | null`
  per `contracts/webhook-to-event-mapping.md`.
  - Implement the Q1=A mapping table exactly: `issues.labeled`/`unlabeled` →
    `label-change`; `issues.closed` → `issue-closed`; `pull_request.closed`
    (merged=true) → `pr-merged`, (merged=false) → `pr-closed`;
    `check_run.completed` / `check_suite.completed` → `pr-checks` (one event per
    matched PR).
  - Explicitly return `null` for `pull_request_review*` and `issue_comment` (Q1=A: OUT).
  - Coarse pre-filter: repo not in `refSet.watchedRepos` → `null` before decoding
    the payload's ref key.
  - Ref-set membership: check `owner/repo#N` key in `refSet.issues` (for `issues.*`)
    or `refSet.prs` (for `pull_request.*`, `check_run.*`, `check_suite.*`).
  - Emitted `CockpitEventValidated` shape per contract § Emitted shape: `from`/`to`
    are `null` (best-effort documented — doorbell stdout consumers use only `event.type`).
  - Reuse `CockpitEventSchema` from `packages/generacy/src/cli/commands/cockpit/watch/emit.ts`
    — do NOT extend the enum.

- [ ] T013 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/doorbell/source-selector.ts`
  exporting `SourceSelector` class per `contracts/source-selector.md` and
  `data-model.md` § SourceSelector.
  - State machine (Q3=D): `smee-attempt → smee-active → poll-fallback` with 5-min
    re-promotion timer when initial mode was `smee-attempt`.
  - Emit exactly one FR-006 stderr line per transition via `options.stderr.write(...)`
    with the format `cockpit doorbell: source=<smee|poll-fallback> reason=<reason>\n`.
  - Startup lines: `startup-smee-selected` on `initial: 'smee-attempt'`;
    `startup-no-channel` on `initial: 'poll-fallback'`.
  - Constants: `DEFAULT_DEMOTE_AFTER_FAILURES = 5`,
    `DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS = 300_000`,
    `DEFAULT_RE_PROMOTE_INTERVAL_MS = 300_000`.
  - Timers: `elapsedTicker` at 1 s cadence (calls `observeElapsed`), `rePromoteTimer`
    armed on entry to `poll-fallback` iff initial was `smee-attempt`. Both cleared
    on `stop()` (idempotent).
  - `onModeChange(cb)` supports multiple callbacks in insertion order.
  - `stderr.write` failures are swallowed. Never throws.

## Phase 3: Aggregate-on-demand (needs poll-mode helpers)

- [ ] T020 [US1] Create `packages/generacy/src/cli/commands/cockpit/doorbell/aggregate-on-demand.ts`
  exporting `maybeRefreshAggregate(input: AggregateRefreshInput): Promise<AggregateRefreshOutput>`
  per `contracts/aggregate-on-demand.md`.
  - `null` trigger short-circuits with zero I/O: return identity output (no `resolveEpic`,
    no `runOnePoll` calls).
  - On trigger, run in order: `resolveEpic` (only if `currentResolved == null`) →
    `runOnePoll(prev, { gh, refs: resolved.parsed.allRefs, epicOwnerRepo, logger })` →
    `computeAggregateEvents({ curr, parsed, epicRepo, epicNumber, prevState: prevAgg, initial: false, now })`.
  - Import `resolveEpic`, `runOnePoll`, `computeAggregateEvents`, `AggregateState`,
    `SnapshotMap`, `initialAggregateState` from their existing locations
    (`mcp/event-bus-registry.ts` / `watch/aggregate.ts` / `watch/poll.ts` etc. —
    trace the exports; do not duplicate the poll code).
  - Failure behavior: `resolveEpic` / `runOnePoll` errors → log warn, return
    identity output; never throw.
  - Do NOT implement debouncing here — that lives in the caller (`SmeeDoorbellSource`).

## Phase 4: Smee SSE consumer

- [ ] T030 [US1] Create `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts`
  exporting `SmeeDoorbellSource` class per `contracts/smee-doorbell-source.md` and
  `data-model.md` § SmeeDoorbellSourceOptions.
  - Model after `packages/orchestrator/src/services/smee-receiver.ts` (native
    `fetch` + `response.body.getReader()`, exponential backoff). Copy the SSE
    read loop skeleton but drive events through `sse-parser.ts` (T011) instead
    of an inline parser.
  - Reconnect ladder: `BASE_RECONNECT_DELAY_MS * 2^attempt`, capped at `300_000`.
    Report each attempt via `onReconnectAttempt(++failedAttempts)`; on connect,
    call `onReconnectSuccess()` (resets counter). Constants:
    `DEFAULT_BASE_RECONNECT_DELAY_MS = 5_000`, `MAX_BACKOFF_MS = 300_000`.
  - Ref-set refresh (Q2=D): startup blocking `resolveEpic` call → build initial
    `RefSetView`; on epic-issue payloads (`issue.number === epicNumber &&
    action ∈ {edited, labeled, unlabeled}`) with 500 ms debounce
    (`DEFAULT_REFRESH_DEBOUNCE_MS = 500`); safety-net `setInterval` every
    `DEFAULT_SAFETY_NET_INTERVAL_MS = 600_000` (10 min).
  - For every non-null payload, in order:
    1. `webhookToStreamEvent(...)` (T012) → if non-null, `await onEvent(event)`.
    2. Derive `AggregateTrigger` and call `maybeRefreshAggregate(...)` (T020) if
       trigger !== null; debounce triggers within 500 ms; on returned events,
       call `await onEvent(agg)` once per event.
  - Ref-set refresh failures: log warn, preserve previous ref-set (do NOT stop
    the SSE loop).
  - `stop()`: set `running = false`, `abortController.abort()`, clear both timers,
    idempotent. Await in-flight fetch to drain.
  - Test seams (all in constructor options): `fetch`, `now`, `runner`,
    `refreshDebounceMs`, `safetyNetIntervalMs`, `baseReconnectDelayMs`.

## Phase 5: Wire runDoorbell to source-select

- [ ] T040 [US1] Modify `packages/generacy/src/cli/commands/cockpit/doorbell.ts`:
  - Keep `writeLine(stdout, 'armed\n')` at its current site (immediately after
    argument validation — Q5=A / spec-explicit "unconditional, before source
    selection").
  - After `armed\n`, call `discoverChannelUrl({ env: process.env, channelFilePath:
    DEFAULT_CHANNEL_FILE_PATH, fs: fsPromises })`.
  - Construct `SourceSelector` with `initial: discovery == null ? 'poll-fallback' : 'smee-attempt'`.
    Selector emits the initial `source=…` line synchronously.
  - Extract the existing `acquire → subscribeAndEmit → stopPromise → release` block
    into a `runPollMode(...)` local helper. Zero behavior change; call this from
    both the initial `poll-fallback` branch and from the demote path.
  - Add `runSmeeMode({ channelUrl, ..., selector, onEvent })` local helper: constructs
    `SmeeDoorbellSource` (T030), wires `onEvent` to `lineForEvent → stdout.write`,
    forwards reconnect callbacks to `selector`.
  - Wire `selector.onModeChange((next, reason) => …)`: on transition from smee-active
    to poll-fallback, tear down `SmeeDoorbellSource` and start `runPollMode`. On
    re-promote transition back to smee-attempt, tear down `runPollMode` release()
    and construct a fresh `SmeeDoorbellSource`.
  - Preserve `--exit-on-epic-complete` semantics in both modes (smee-mode fires it
    via aggregate-on-demand emissions; poll-mode fires it via existing bus events).
  - No changes to `subscribe.ts` (poll-mode subscriber stays verbatim).

## Phase 6: Tests

- [ ] T050 [P] [US1] Add `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/channel-discovery.test.ts`
  covering every row of `contracts/channel-discovery.md` § Test cases:
  env-first precedence; ENOENT silent; malformed file → null + one warn; env
  invalid → env warn + file fall-through; non-smee URL → null + one warn;
  trailing-whitespace env value → null (regex doesn't match; no fall-through).

- [ ] T051 [P] [US1] Add `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/sse-parser.test.ts`
  covering: single event/data pair; multi-line `data:` joined with `\n`;
  `ready`/`ping` frames → null; malformed JSON → null; missing `x-github-event`
  → null.

- [ ] T052 [P] [US1] Add `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/webhook-to-event.test.ts`
  row-by-row per `contracts/webhook-to-event-mapping.md`:
  `issues.labeled` in refSet → `label-change`; `issues.labeled` not in refSet →
  null; `issues.unlabeled` in refSet → `label-change`; `issues.closed` → `issue-closed`;
  `pull_request.closed` merged=true → `pr-merged`; merged=false → `pr-closed`;
  `check_run.completed` with matched PR → `pr-checks`; `check_suite.completed`
  with matched PR → `pr-checks`; `pull_request_review.submitted` → null (Q1=A);
  `issue_comment.created` → null; `push`/`ping` → null; repo not in
  `refSet.watchedRepos` → null (coarse pre-filter).

- [ ] T053 [P] [US1] Add `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/source-selector.test.ts`
  covering `contracts/source-selector.md` § Test cases:
  construction with `initial: 'smee-attempt'` emits `startup-smee-selected` line;
  construction with `initial: 'poll-fallback'` emits `startup-no-channel` line;
  first `onReconnectSuccess()` transitions to `smee-active` silently; 4 attempts
  don't demote; 5th attempt demotes with `smee-runtime-lost`;
  `observeElapsed()` past 5 min window demotes; re-promote timer transitions
  `poll-fallback → smee-attempt` silently; subsequent success emits
  `smee-re-promoted`; `stop()` clears timers; failed reconnects reset on success.

- [ ] T054 [P] [US1] Add `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/aggregate-on-demand.test.ts`
  covering `contracts/aggregate-on-demand.md` § Test cases:
  `trigger=null` → zero `gh` calls, identity output; `completed:implement` label
  trigger → one `resolveEpic` + one `runOnePoll` + `phase-complete` when all
  implement refs closed in snapshot; `issue-closed` trigger with all refs closed
  → `epic-complete`; consecutive same-trigger calls idempotent (no double-emit
  via `seenCompletePhases`); `resolveEpic` throws → identity output + one warn.

- [ ] T055 [US1] Add `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/smee-source.integration.test.ts`
  spinning up an in-process `node:http` server on `127.0.0.1:0` that streams
  SSE frames matching smee.io's format. Cover:
  - Matching payload → exactly one doorbell stdout line with correct `event.type`.
  - Payload for repo not in `watchedRepos` → zero lines.
  - Payload for issue not in `refSet.issues` → zero lines.
  - `issues.labeled` with `label.name === 'completed:implement'` where all
    implement refs are closed in the mock snapshot → two lines (`label-change`
    then `phase-complete`).
  - Server drops connection → source reconnects with backoff; after 5 fails,
    `onReconnectAttempt(5)` fires (demotion handled by SourceSelector).
  - p95 latency assertion per spec § Success-Criteria Traceability:
    ≤ 3 s from SSE frame delivery to `stdout.write` across 100 simulated events
    (with `baseReconnectDelayMs: 10` to keep the test wall-clock bounded).

- [ ] T056 [US1] Add `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/doorbell-source-branch.test.ts`
  covering `runDoorbell` branch selection:
  - No channel file, no env override → poll-mode path taken (spy on
    `acquireEpicBus`); `armed\n` written before selection.
  - Env override with valid smee URL → smee-mode path taken (spy on
    `SmeeDoorbellSource` constructor).
  - Malformed channel file → poll-mode path taken; one `warn` line;
    `armed\n` still written first.

## Phase 7: Verification

- [ ] T060 [US1] Run `pnpm -F @generacy-ai/generacy test` and confirm all new
  suites pass and the #970 regression suites still pass verbatim:
  `event-bus-catchup-skip.test.ts`, `event-bus-epic-refresh-cadence.test.ts`,
  `pr-state-checks-gate.test.ts`, `gh-cache.test.ts`,
  `rate-limit-scheduler.test.ts`.

- [ ] T061 [US1] Run `pnpm -F @generacy-ai/generacy build` and `pnpm -w typecheck`
  (or the workspace equivalent) to catch type regressions across the
  `packages/generacy/src/cli/commands/cockpit/` surface.

- [ ] T062 [US1] Confirm the changeset gate passes locally: `pnpm changeset status`
  should list `.changeset/978-cockpit-doorbell-smee.md` against
  `@generacy-ai/generacy`. Verify no other packages appear (the diff is
  contained inside `packages/generacy/`).

## Dependencies & Execution Order

**Phase 1** (T001) is independent — it can be added at any time before the PR is opened, but landing it first satisfies the CI changeset gate for every subsequent commit.

**Phase 2** (T010–T013) has no internal dependencies — all four pure-function modules can be authored in parallel. None imports from another Phase 2 file.

**Phase 3** (T020) depends on knowledge of the poll-mode exports (`resolveEpic`,
`runOnePoll`, `computeAggregateEvents`, `AggregateState`, `SnapshotMap`) but does
NOT depend on any Phase 2 file at import time. Can start in parallel with Phase 2.

**Phase 4** (T030) depends on T011 (`sse-parser.ts`), T012 (`webhook-to-event.ts`),
and T020 (`aggregate-on-demand.ts`). It does NOT depend on T010 or T013 (those
are used by `doorbell.ts` in Phase 5, not by `SmeeDoorbellSource`).

**Phase 5** (T040) depends on T010 (`discoverChannelUrl`), T013 (`SourceSelector`),
and T030 (`SmeeDoorbellSource`). This is the fan-in that wires the module together.

**Phase 6** (T050–T056):
- T050–T054 are unit tests for pure functions and can be authored in parallel
  with their target modules (or immediately after). T050 pairs with T010;
  T051 with T011; T052 with T012; T053 with T013; T054 with T020.
- T055 (smee-source integration) depends on T030 landing.
- T056 (branch selection) depends on T040 landing.

**Phase 7** (T060–T062) depends on all prior phases and runs sequentially.

**Parallel opportunities**:
- T010, T011, T012, T013, T020 all in parallel (5 independent pure-function modules).
- T050, T051, T052, T053, T054 all in parallel once their targets exist.
- T061, T062 can run in parallel with T060 (all read-only against the built output).

**No parallel opportunity** at T030, T040, T055, T056 — each is a single-file
concentration point with upstream dependencies.

## Playbook coupling — verification task

`spec.md`, `plan.md`, and the issue body contain **zero** references matching
`packages/claude-plugin-cockpit/commands/*.md`. No re-pin of
`packages/claude-plugin-cockpit/tests/playbook-verification.test.ts` is
required for this issue.

---

*Generated by speckit*
