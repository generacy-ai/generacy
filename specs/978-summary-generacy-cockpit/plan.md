# Implementation Plan: Cockpit doorbell subscribes to smee stream (revised FR-011)

**Feature**: Make `generacy cockpit doorbell` real-time-first — subscribe to the cluster's smee.io SSE stream when configured, keep the existing 30 s event-bus poll loop as a safety-net fallback. Removes the ~25 s poll-derived notification latency on smee-live clusters without regressing the poll-only path.
**Branch**: `978-summary-generacy-cockpit`
**Status**: Complete

## Summary

Today `generacy cockpit doorbell <ref>` calls `acquireEpicBus()` and then blocks on
`bus.waitFor(...)`. That bus is fed by a 30 s GitHub poll loop
(`event-bus-registry.ts`), so wake latency is bounded by the poll, not by the raw
webhook stream. The revised FR-011 posted on #970 — "doorbell subscribes to the
smee stream, poll only as fallback" — was commented on the parent issue but
never built.

The fix is a source-selection layer inside `runDoorbell`, not a rewrite of the
doorbell command surface:

1. **Source discovery.** At startup, read the smee channel URL the orchestrator
   already persists at `config.smee.channelFilePath` (default
   `/var/lib/generacy/smee-channel`, written by `SmeeChannelResolver`). Env
   override `COCKPIT_DOORBELL_SMEE_URL` for tests/manual use. If neither
   yields a well-formed `https://smee.io/[A-Za-z0-9_-]+` URL, we start
   directly in **poll-fallback** mode.
2. **Smee-mode SSE consumer.** Model a slim client on
   `packages/orchestrator/src/services/smee-receiver.ts` (`fetch` + SSE parse,
   exponential backoff 5 s → 300 s). Filter payloads to the epic's resolved
   ref set; on the epic-issue ref itself, refresh `resolveEpic` (Q2=D hybrid).
   For each matching payload, emit one doorbell stdout line via the same
   `lineForEvent` translator today's poll path uses.
3. **Aggregate events on demand.** When an SSE payload carries a `completed:*`
   label OR an `issues.closed` / `pull_request.closed` action, run a single
   on-demand `resolveEpic + runOnePoll` snapshot refresh, diff the
   `AggregateState` in-process, and emit `phase-complete` / `epic-complete`
   via the existing `computeAggregateEvents`. This is Q4=A: no background
   poll, no `acquireEpicBus` in smee mode (FR-007 preserved),
   `--exit-on-epic-complete` still fires in real time.
4. **Runtime demotion (Q3=D).** After 5 consecutive reconnect failures
   (~2.5 min) or 5 min without a successful reconnect, demote to poll-fallback
   for the run; re-attempt smee-mode promotion every 5 min. Log each source
   transition to stderr as the FR-006 `source=…` line.
5. **`armed\n` timing (Q5=A).** Written unconditionally, immediately after
   argument validation — before source selection. `armed\n` stays a pure
   liveness signal; the FR-006 `source=…` line is the "which source settled"
   signal.
6. **Poll-fallback path is unchanged.** When smee is unreachable, doorbell
   falls through to today's `acquireEpicBus` + `subscribeAndEmit` code path.
   All #970 poll-cost reductions (check-run gate, cache, `resolveEpic`
   cadence, catch-up skip, rate-limit scheduler) apply verbatim.

The doorbell process runs inside the orchestrator container, so the smee
channel file is on the local filesystem — no cross-container plumbing.

## Technical Context

- **Language/Version**: TypeScript (ESM, Node >=22)
- **Primary Dependencies**: `zod` (existing — validate SSE payload
  discriminators). No new deps. `fetch` is the native runtime API used by
  `SmeeWebhookReceiver`; the doorbell's SSE client uses the same primitives.
- **Packages touched**: `packages/generacy/` (all changes). No new package.
  No changes to `@generacy-ai/cockpit` (event schemas untouched — Q1=A).
  No changes to `@generacy-ai/orchestrator` (the persisted channel file is
  a filesystem artifact, not a shared import).
- **Test runner**: Vitest, matching existing convention in
  `packages/generacy/src/cli/commands/cockpit/__tests__/` and
  `.../doorbell/__tests__/`.
- **Storage**: Filesystem-read only (smee channel file). In-process state
  for `AggregateState`, ref-set filter, and reconnect counters. No shared
  memory with the orchestrator process.
- **Performance goals**: On smee-live clusters, latency from a label
  transition to doorbell stdout line ≤ ~3 s p95 (vs. ~25 s today). No
  regression to poll-mode latency or GraphQL spend when smee is unavailable.
- **Constraints**: `armed\n` timing unchanged (agency#431 depends on it).
  Stdout event line shape unchanged (`event.type\n`, per `lineForEvent`).
  `CockpitStreamEvent` union unchanged (Q1=A — wake-source swap, not a
  protocol change).

## Constitution Check

No `.specify/memory/constitution.md` in repo. Skipped.

Existing project conventions honoured:

- **Changeset required** (`.github/workflows/changeset-bot.yml`) — this diff
  touches non-test files under `packages/generacy/src/`. Add a
  `.changeset/978-cockpit-doorbell-smee.md` listing `@generacy-ai/generacy`
  at `patch` (internal behavior change, no CLI surface change; the FR-006
  `source=…` line is stderr, not a public contract shift).
- **No changes to `@generacy-ai/cockpit` public exports** — the doorbell owns
  its own SSE client and ref-set filter. No new exports from `packages/cockpit/`
  are required by this plan.
- **No new inter-process signal** — smee channel is discovered by reading the
  same file the orchestrator's `SmeeChannelResolver` writes. No IPC, no shared
  state, no wire protocol change. Q2=D hybrid refresh uses only local state
  and SSE payloads.
- **Failure paths degrade to existing behavior** — every smee-mode failure
  (missing file, malformed URL, connect fail, sustained reconnect loss)
  collapses to the poll-fallback path that already ships. There is no
  "smee-mode only" reachable state that has no fallback.
- **No comments describing WHAT** — helpers named for what they do; `Why:`
  comments only for non-obvious constraints (e.g., "N=5 reconnects chosen to
  match orchestrator smee-receiver backoff at ~2.5 min elapsed",
  "aggregate refresh runs only on completion signals to preserve FR-007").
- **Vitest, no snapshot fixtures** — matches existing test style in
  `packages/generacy/src/cli/commands/cockpit/watch/__tests__/`.
- **Q1=A preserved end-to-end** — `CockpitEventSchema` enum
  (`label-change | issue-closed | pr-merged | pr-closed | pr-checks`)
  is not extended. `pull_request_review` / `issue_comment` events do not
  produce a doorbell line under this plan. Anyone who needs on-sibling-review
  wake via smee should file a follow-up.

## Project Structure

```
packages/generacy/
  src/cli/commands/cockpit/
    doorbell.ts                              MOD  — runDoorbell branches to
                                                    smee-mode source selection when
                                                    a channel URL resolves; otherwise
                                                    falls through to the existing
                                                    acquireEpicBus path unchanged.
                                                    Emits FR-006 `source=…` stderr
                                                    line after source settles.
                                                    `armed\n` still written before
                                                    source selection (Q5=A).
    doorbell/
      subscribe.ts                           (unchanged) — poll-mode subscriber
                                                    still used verbatim on
                                                    fallback.
      smee-source.ts                         NEW  — SmeeDoorbellSource: SSE
                                                    consumer with exponential
                                                    backoff, ref-set filter,
                                                    on-epic-payload
                                                    resolveEpic refresh
                                                    (Q2=D), demotion counter
                                                    (Q3=D).
      channel-discovery.ts                   NEW  — pure function:
                                                    discoverChannelUrl({ env,
                                                    channelFilePath, fs }) →
                                                    { url, source } | null.
                                                    Reads env override first,
                                                    then persisted file.
      sse-parser.ts                          NEW  — pure function:
                                                    parseSseEventBlock(text)
                                                    → { githubEvent, action,
                                                    body }. Same shape as
                                                    smee-receiver.ts's inline
                                                    parser, factored out so
                                                    both sides can share tests.
      webhook-to-event.ts                    NEW  — pure function:
                                                    webhookToStreamEvent(
                                                      githubEvent, action,
                                                      body, refSet, now
                                                    ) → CockpitStreamEvent
                                                    | null. Q1=A mapping
                                                    table; skips non-matching
                                                    events + non-matching
                                                    refs.
      aggregate-on-demand.ts                 NEW  — pure function:
                                                    maybeRefreshAggregate({
                                                      trigger, prevAgg, prev,
                                                      resolved, gh, logger,
                                                      now
                                                    }) → { events,
                                                    nextAgg, nextPrev,
                                                    nextResolved? }.
                                                    Delegates to
                                                    resolveEpic + runOnePoll
                                                    + computeAggregateEvents
                                                    only when trigger !== null.
      source-selector.ts                     NEW  — SourceSelector class:
                                                    owns runtime demotion +
                                                    re-promotion counters,
                                                    emits `source=…` stderr
                                                    lines on each
                                                    transition (Q3=D).
      __tests__/
        channel-discovery.test.ts            NEW  — env > file precedence;
                                                    ENOENT + malformed +
                                                    non-smee URL all → null.
        sse-parser.test.ts                   NEW  — event/data pairing, ping
                                                    + ready events ignored,
                                                    multi-line data joined.
        webhook-to-event.test.ts             NEW  — Q1=A mapping table row
                                                    by row (issues.labeled →
                                                    label-change, issues.closed
                                                    → issue-closed,
                                                    pull_request.closed
                                                    merged=true → pr-merged,
                                                    merged=false →
                                                    pr-closed,
                                                    check_run.completed →
                                                    pr-checks,
                                                    check_suite.completed
                                                    → pr-checks,
                                                    pull_request_review → null,
                                                    issue_comment → null,
                                                    ref not in set → null).
        aggregate-on-demand.test.ts          NEW  — trigger=null → no fetch,
                                                    no events; trigger=
                                                    'completed-label' → one
                                                    resolveEpic + one
                                                    runOnePoll + diff;
                                                    epic-complete emitted
                                                    when all refs closed.
        source-selector.test.ts              NEW  — Q3=D matrix: 4 fails →
                                                    stay smee, 5th → demote;
                                                    2 successful reconnects
                                                    reset counter; 5 min
                                                    demoted → re-promote
                                                    attempt.
        smee-source.integration.test.ts      NEW  — spin up an in-process
                                                    HTTP server that emits
                                                    SSE frames, assert
                                                    doorbell writes one
                                                    stdout line per matching
                                                    payload and zero for
                                                    non-matching (repo /
                                                    ref / event type).
        doorbell-source-branch.test.ts       NEW  — no channel file →
                                                    poll-fallback path
                                                    taken; env override
                                                    present → smee path
                                                    taken; malformed file
                                                    → poll-fallback +
                                                    warning.

specs/978-summary-generacy-cockpit/
  spec.md                                    (untouched — read-only)
  clarifications.md                          (unchanged)
  plan.md                                    NEW (this file)
  research.md                                NEW
  data-model.md                              NEW
  contracts/
    channel-discovery.md                     NEW — public shape + precedence
    smee-doorbell-source.md                  NEW — SSE client lifecycle,
                                                    reconnect ladder,
                                                    demotion semantics
    webhook-to-event-mapping.md              NEW — Q1=A mapping table
    aggregate-on-demand.md                   NEW — Q4=A trigger algorithm
    source-selector.md                       NEW — Q3=D state machine
  quickstart.md                              NEW

.changeset/
  978-cockpit-doorbell-smee.md               NEW — patch @generacy-ai/generacy
```

**Structure Decision**: All changes land inside
`packages/generacy/src/cli/commands/cockpit/doorbell/`. The doorbell command
already has its own subdirectory (`subscribe.ts`); this plan grows it to a
6-file module. `runDoorbell` (in `doorbell.ts`) becomes a router that either
enters the smee source or falls through to today's `acquireEpicBus` block.
No changes escape the `cockpit/doorbell/` folder except a tiny `runDoorbell`
branch. The smee code is isolated from the poll path so a bug in the new
SSE client cannot regress operators who don't have smee configured.

## Design Overview

### `runDoorbell` branch selection (`doorbell.ts`)

```ts
// Existing:
await writeLine(stdout, 'armed\n');

// NEW: source discovery + selector.
const discovery = discoverChannelUrl({
  env: process.env,
  channelFilePath: DEFAULT_CHANNEL_FILE_PATH,   // /var/lib/generacy/smee-channel
  fs: node:fs/promises,
});
const selector = new SourceSelector({
  initial: discovery == null ? 'poll' : 'smee-attempt',
  stderr,
  logger,
});

if (selector.currentSource === 'smee-attempt') {
  await runSmeeMode({ channelUrl: discovery!.url, form, options, selector, ... });
} else {
  await runPollMode({ form, options, ... });   // today's acquireEpicBus block
}
```

`runPollMode` is a straight-line extract of the existing `acquire → armed
→ subscribeAndEmit → stopPromise → release` sequence from `doorbell.ts`.
No behavior change; refactored purely so `runDoorbell` can pick a mode.

`runSmeeMode` spins up a `SmeeDoorbellSource`, forwards each translated
event to `stdout` via `lineForEvent`, and observes `selector` for
runtime demotion. On demotion, tears down the SSE client and starts the
poll-mode block — the run continues, latency reverts to poll cadence,
`--exit-on-epic-complete` still fires (via aggregate-on-demand until
demotion, then via poll-mode aggregates after).

**FR-006 `source=…` stderr line**: written by `SourceSelector.transitionTo(...)`
on every source change. Format:
```
cockpit doorbell: source=<smee|poll-fallback> reason=<startup-no-channel|startup-smee-selected|smee-runtime-lost|smee-re-promoted>
```

### `DoorbellChannelDiscovery` (`channel-discovery.ts`)

Pure function. Reads env override first (`COCKPIT_DOORBELL_SMEE_URL`), then
the persisted channel file. Returns the URL + source tag or `null`. Never
throws; malformed content logs a warning and returns `null`.

```ts
export interface ChannelDiscoveryInput {
  env: NodeJS.ProcessEnv;
  channelFilePath: string;               // default: /var/lib/generacy/smee-channel
  fs: Pick<typeof import('node:fs/promises'), 'readFile'>;
  logger?: { warn?: (msg: string) => void };
}

export interface ChannelDiscoveryResult {
  url: string;                            // matches /^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/
  source: 'env' | 'file';
}

export async function discoverChannelUrl(
  input: ChannelDiscoveryInput,
): Promise<ChannelDiscoveryResult | null>;
```

Precedence:
1. `env.COCKPIT_DOORBELL_SMEE_URL` — if present, must match `SMEE_URL_PATTERN`
   (`/^https:\/\/smee\.io\/[A-Za-z0-9_-]+$/`, same as
   `SmeeChannelResolver.SMEE_URL_PATTERN`).
2. `readFile(channelFilePath, 'utf-8')` → trim → same regex.

Any failure returns `null` and logs `warn` (except ENOENT — silent, expected
on webhook-less clusters).

### `SmeeDoorbellSource` (`smee-source.ts`)

Slim SSE consumer. Modelled directly on `SmeeWebhookReceiver`
(`packages/orchestrator/src/services/smee-receiver.ts`) but:

- No `LabelMonitorService`. Emits into a caller-supplied
  `(event: CockpitStreamEvent) => Promise<void>` sink.
- Ref-set filter derived from `resolveEpic(...)` at startup. Passed as
  `Set<string>` of `owner/repo#number` keys plus a `Set<string>` of watched
  repos (payloads outside these are dropped before parsing).
- On any payload where `issue.number === epicNumber` AND
  `x-github-event === 'issues'` AND `action ∈ {edited, labeled, unlabeled}`
  (Q2=D), fires a debounced `refreshRefSet()` that re-runs `resolveEpic`
  and swaps the internal filter.
- Safety-net timer: `setInterval(refreshRefSet, 10 * 60_000)` (Q2=D).
- Reconnect backoff exactly matches `SmeeWebhookReceiver`:
  `5s → 10s → 20s → 40s → 80s → 160s → 300s (capped)`.
- Reports each connect / disconnect / reconnect failure to the caller
  (`SourceSelector`) via `onReconnectAttempt` / `onReconnectSuccess`
  callbacks so demotion counting is external to the SSE client.

```ts
export interface SmeeDoorbellSourceOptions {
  channelUrl: string;
  epicRef: string;                        // owner/repo#number
  gh: GhWrapper;
  runner?: CommandRunner;
  logger: { warn: (msg: string) => void; info?: (msg: string) => void };
  onEvent: (event: CockpitStreamEvent) => Promise<void>;
  onReconnectAttempt: (failedAttempts: number) => void;   // fed to SourceSelector
  onReconnectSuccess: () => void;
  onRefSetRefreshFailure?: (err: unknown) => void;
  now?: () => number;                     // test seam
  fetch?: typeof globalThis.fetch;        // test seam
  refreshDebounceMs?: number;             // default 500 ms
  safetyNetIntervalMs?: number;           // default 600_000 (10 min)
  baseReconnectDelayMs?: number;          // default 5_000
}

export class SmeeDoorbellSource {
  constructor(options: SmeeDoorbellSourceOptions);
  start(): Promise<void>;    // launches connect loop; returns when ready
  stop(): Promise<void>;     // aborts SSE, clears timers
}
```

### `webhookToStreamEvent` (`webhook-to-event.ts`)

Pure Q1=A mapping. Takes a normalized `{ githubEvent, action, body }` triple
and the current ref-set filter, returns one `CockpitStreamEvent` or `null`.

```ts
export function webhookToStreamEvent(
  githubEvent: string,
  action: string,
  body: Record<string, unknown>,
  refSet: RefSetView,                     // { issues: Set<string>, prs: Set<string>, watchedRepos: Set<string> }
  now: () => string,
): CockpitStreamEvent | null;
```

Mapping table (see `contracts/webhook-to-event-mapping.md` for full row-by-row detail):

| githubEvent | action | payload discriminator | emitted `event` |
|---|---|---|---|
| `issues` | `labeled` | `label.name` present | `label-change` (from = label removed, to = derived) |
| `issues` | `unlabeled` | `label.name` present | `label-change` |
| `issues` | `closed` | — | `issue-closed` |
| `pull_request` | `closed` | `pull_request.merged === true` | `pr-merged` |
| `pull_request` | `closed` | `pull_request.merged === false` | `pr-closed` |
| `check_run` | `completed` | `check_run.pull_requests[*]` | `pr-checks` (one per associated PR that matches refSet.prs) |
| `check_suite` | `completed` | `check_suite.pull_requests[*]` | `pr-checks` |
| `pull_request_review` | any | — | `null` (Q1=A: out of scope) |
| `pull_request_review_comment` | any | — | `null` |
| `issue_comment` | any | — | `null` |
| anything else | any | — | `null` |

`from`/`to` best-effort per Q1=A: computed from `payload.labels[]` snapshot
without a full snapshot diff. The doorbell stdout line ignores these fields
(it emits only `event.type`), so best-effort is functionally lossless for
the doorbell wake signal; the authoritative diff still lives in
`cockpit_await_events` on the poll bus (which the smee source does not touch).

### `maybeRefreshAggregate` (`aggregate-on-demand.ts`)

Q4=A: aggregate events computed only when the SSE payload could plausibly
complete a phase or an epic. All other payloads produce zero GraphQL cost.

Trigger predicate:
- `githubEvent === 'issues' && action === 'labeled' && label.name.startsWith('completed:')`
- `githubEvent === 'issues' && action === 'closed'`
- `githubEvent === 'pull_request' && action === 'closed'` (both merged/closed)

On trigger, run once:
1. `resolveEpic({ epicRef, gh, logger })` — one GraphQL point.
2. `runOnePoll(prev, { gh, refs: resolved.parsed.allRefs, epicOwnerRepo, logger })`
   — same cost as one poll cycle (already gate-optimized by #970).
3. `computeAggregateEvents({ curr, parsed, epicRepo, epicNumber, prevState:
   currentAggState, initial: false, now })` — pure.

Returns `{ events, nextAgg, nextPrev, nextResolved }`. Emits are appended to
the doorbell stdout stream via `lineForEvent` alongside the issue-transition
event from the SSE payload.

Coalesce with debounce: if two completion signals arrive within 500 ms, run
the refresh once. Prevents fan-out amplification during epic-completion
bursts.

### `SourceSelector` state machine (Q3=D)

```
                 startup, discovery == null
                 ────────────────────────────────►  poll-fallback (permanent)

                 startup, discovery != null
                 ────────────────────────────────►  smee-attempt
                                                          │ connect OK
                                                          ▼
                                                     smee-active
                                                          │ 5 consecutive reconnect
                                                          │ failures OR 5 min elapsed
                                                          │ since last successful
                                                          │ connect
                                                          ▼
                                                     poll-fallback ──┐
                                                          ▲          │ every 5 min:
                                                          │          │ retry smee-mode
                                                          └──────────┘ (transition to
                                                                       smee-attempt
                                                                       again on next
                                                                       tick)
```

State field summary (see `contracts/source-selector.md`):

```ts
interface SourceSelectorState {
  current: 'smee-attempt' | 'smee-active' | 'poll-fallback';
  consecutiveReconnectFailures: number;
  lastSuccessfulConnectAt: number | null;
  demotedAt: number | null;               // for the 5-min re-promotion timer
}
```

Transition emits are the single-line `source=…` stderr messages. Every
transition writes exactly one line; no state change is silent.

### Interaction diagram

```
┌──────────── runDoorbell ────────────┐
│                                     │
│  parse args → armed\n → discover ─┬─► null → runPollMode (unchanged)
│                                    │
│                                    └─► url → SourceSelector('smee-attempt')
│                                         │
│                                         ▼
│                                   SmeeDoorbellSource
│                                    │  onEvent(ev)
│                                    ▼
│                                lineForEvent → stdout
│                                    │
│                                    └─ trigger? ─► aggregate-on-demand → extra lines
│
│  onReconnectAttempt(n≥5) → selector.demote()
│                              │
│                              └─► stop smee → start runPollMode
│                                            (5-min timer keeps trying to re-promote)
└─────────────────────────────────────┘
```

## Behavior Matrix

### Discovery → initial source (FR-006 / Q3=D + Q5=A)

| env `COCKPIT_DOORBELL_SMEE_URL` | file at `channelFilePath` | initial source | `source=…` line |
|---|---|---|---|
| valid smee URL | anything | `smee-attempt` | `source=smee reason=startup-smee-selected` |
| unset | valid smee URL | `smee-attempt` | `source=smee reason=startup-smee-selected` |
| unset | ENOENT | `poll-fallback` | `source=poll-fallback reason=startup-no-channel` |
| unset | malformed | `poll-fallback` | `source=poll-fallback reason=startup-no-channel` |
| invalid | anything | `poll-fallback` (warn on env) | `source=poll-fallback reason=startup-no-channel` |

`armed\n` is written before this line (Q5=A).

### Q1=A webhook → doorbell event mapping (subset)

| `x-github-event` | `action` | ref matches | doorbell line? |
|---|---|---|---|
| `issues` | `labeled` | ✓ | ✓ `label-change\n` |
| `issues` | `labeled` | ✗ | — |
| `issues` | `unlabeled` | ✓ | ✓ `label-change\n` |
| `issues` | `opened` | ✓ | — (out of scope, not in enum) |
| `issues` | `closed` | ✓ | ✓ `issue-closed\n` (+ maybe `phase-complete`, `epic-complete`) |
| `pull_request` | `closed` (merged=true) | ✓ | ✓ `pr-merged\n` (+ maybe `phase-complete`, `epic-complete`) |
| `pull_request` | `closed` (merged=false) | ✓ | ✓ `pr-closed\n` (+ maybe `phase-complete`, `epic-complete`) |
| `pull_request` | `synchronize` | ✓ | — (not in enum) |
| `check_run` | `completed` | any PR in refSet | ✓ `pr-checks\n` |
| `check_suite` | `completed` | any PR in refSet | ✓ `pr-checks\n` |
| `pull_request_review` | any | any | — (Q1=A: out) |
| `issue_comment` | any | any | — (Q1=A: out) |
| `push`, `ping`, other | any | any | — |

### Runtime source transitions (Q3=D)

| trigger | current | consecutive fails | elapsed since last success | next | `source=…` line |
|---|---|---|---|---|---|
| first connect ok | `smee-attempt` | 0 | — | `smee-active` | (already emitted at startup) |
| reconnect attempt fails | `smee-active` | 4 → 5 | any | `poll-fallback` | `source=poll-fallback reason=smee-runtime-lost` |
| 5 min elapsed no reconnect | `smee-active` | 3 | > 300_000 | `poll-fallback` | `source=poll-fallback reason=smee-runtime-lost` |
| 5-min re-promotion timer | `poll-fallback` | 0 (reset) | — | `smee-attempt` | `source=smee reason=smee-re-promoted` (only fires when connect succeeds) |
| all subsequent reconnects fail during re-promote | `smee-attempt` | 5 | — | `poll-fallback` | `source=poll-fallback reason=smee-runtime-lost` |

Counter reset: any successful connect zeroes `consecutiveReconnectFailures` and
updates `lastSuccessfulConnectAt`.

## Risks and Mitigations

1. **Channel file discovery races** — the doorbell may start before the
   orchestrator has provisioned the file. Discovery falls through to
   `poll-fallback` in that case; the 5-min re-promotion timer picks the
   channel up on the next tick after `SmeeChannelResolver` writes it.
   Acceptable because the operator sees the exact same behavior they see
   today (poll fed) until the promote succeeds.
2. **SSE consumer holds the smee stream open, competing with the orchestrator's
   `SmeeWebhookReceiver` for events** — smee.io fans out to every connected
   SSE consumer (docs), so both processes receive every event. No dedup
   concern: label events flow through `LabelMonitorService` on the
   orchestrator side; the doorbell only writes stdout wake lines to the
   agency skill process. Different consumers, different downstreams.
3. **`resolveEpic` on-epic-payload refresh amplifies GraphQL cost during a
   label-edit burst on the epic issue** — 500 ms debounce collapses bursts;
   worst case ≈ 1 refresh per human edit action. Bounded by the safety-net
   timer at ~10 min.
4. **Aggregate-on-demand double-emits `phase-complete` if a poll cycle already
   emitted it** — cannot happen in smee mode: `acquireEpicBus` is not called
   (FR-007). The `AggregateState` lives inside the smee source only. On
   demotion the poll-fallback path starts fresh with `initialAggregateState()`
   and re-emits any not-yet-seen completions; `computeAggregateEvents`
   guards against double-emit via `seenCompletePhases`. Legitimate
   completions never fire twice within a single mode; a completion that
   fires in smee then demotion happens post-emit will not re-fire in poll
   because the SSE-mode `nextAgg` handoff is not carried across —
   documented in `contracts/aggregate-on-demand.md` as an accepted
   theoretical duplicate. Mitigation: agency#431's skill treats
   `epic-complete` as idempotent (any occurrence terminates the loop). The
   doorbell process's `--exit-on-epic-complete` also stops on first
   occurrence, so a second emit never reaches the skill.
5. **Demotion oscillation on flaky networks** — 5-min re-promotion cadence,
   `consecutiveReconnectFailures` reset only on connect success, keeps the
   oscillation cost low (one SSE connect attempt every 5 min). Each
   transition emits one stderr line, so operators can grep for the pattern.
6. **`armed\n` fires before source is chosen (Q5=A)** — this is
   intentional; the FR-006 `source=…` line covers "which source settled".
   Skill startup sweep re-checks live state anyway; the shipped `armed\n`
   contract is unchanged. Operators reading raw stderr may see the
   discovery result up to ~50 ms after `armed\n` on stdout — no consumer
   depends on synchronization between the two streams.
7. **Missing epic-issue `issues.edited` on `gh api` PATCH edits** — the
   safety-net timer at 10 min covers this exact case (Q2=D). Operators
   who edit epic bodies via `gh api` see up to 10 min stale ref-set, then
   normalize.
8. **New `SmeeDoorbellSource` diverges from `SmeeWebhookReceiver` over time**
   — both are ≤ ~250 LOC; each has its own tests. The doorbell has no
   consumer requiring parity with `SmeeWebhookReceiver`. Documented in
   `research.md` as "acceptable duplication until a shared SSE utility is
   demonstrably needed".

## Testing Strategy

### Unit tests

- `channel-discovery.test.ts` — env-first precedence, ENOENT silent, malformed
  file returns null + warns, non-smee URL returns null + warns.
- `sse-parser.test.ts` — event/data pairing, multi-line data joined, ready/ping
  events ignored, malformed JSON silently skipped.
- `webhook-to-event.test.ts` — Q1=A mapping table row by row (see behavior
  matrix above). Assert null for `pull_request_review`, `issue_comment`,
  and any ref not in `refSet`.
- `aggregate-on-demand.test.ts` — trigger=null path makes zero `gh` calls;
  `completed:phase-name` label triggers exactly one `resolveEpic` + one
  `runOnePoll`; `phase-complete` emitted when all refs in a phase close;
  `epic-complete` emitted when all refs close.
- `source-selector.test.ts` — Q3=D matrix: 4 failures don't demote, 5th does;
  5 min since success without reconnect demotes; poll-fallback + 5-min
  timer triggers re-promotion; source= line emitted on every transition
  exactly once.

### Integration tests

- `smee-source.integration.test.ts` — spin up an in-process HTTP server that
  streams SSE frames matching smee.io's format (event: message + data: JSON).
  Assert:
  - Payload matching ref set → exactly one doorbell stdout line, correct
    `event.type`.
  - Payload for repo not in `watchedRepos` → zero lines.
  - Payload for issue not in `refSet.issues` → zero lines.
  - `issues.labeled` where `label.name === 'completed:implement'` → two
    lines (`label-change\n` then, if all implement refs are closed in the
    snapshot mock, `phase-complete\n`).
  - Server drops connection → smee source reconnects with backoff; counters
    increment; after 5 fails, `SourceSelector` demotes.
- `doorbell-source-branch.test.ts` — asserts branch selection in `runDoorbell`:
  no discovery → poll-mode via `acquireEpicBus` spy; env override discovery →
  smee-mode via `SmeeDoorbellSource` spy; malformed file → poll-mode + one
  `warn` line.

### Regression tests kept from #970

- `event-bus-catchup-skip.test.ts`, `event-bus-epic-refresh-cadence.test.ts`,
  `pr-state-checks-gate.test.ts`, `gh-cache.test.ts`,
  `rate-limit-scheduler.test.ts` — all unchanged. The poll-fallback path is
  unchanged from #970's shipped code, so all its guarantees still hold.

## Success-Criteria Traceability

The spec's Success Criteria table is a template placeholder. Once populated,
tie:

- **Smee-mode wake latency ≤ ~3 s p95** → `smee-source.integration.test.ts`
  measures the wall-clock time from SSE frame delivery to `stdout.write`.
  Confirm ≤ 3 s at p95 across 100 simulated events.
- **Poll-fallback latency unchanged** →
  `event-bus-catchup-skip.test.ts` +
  `event-bus-epic-refresh-cadence.test.ts` continue to pass verbatim.
- **`--exit-on-epic-complete` still fires in smee mode** →
  `smee-source.integration.test.ts` epic-complete case.
- **Zero regression on FR-006 capability probe (agency#431)** — no change to
  `armed\n` timing (Q5=A); `source=…` line is additive stderr, not gated on.
- **No new GraphQL spend baseline in smee-mode** —
  `aggregate-on-demand.test.ts` proves the null-trigger path makes zero
  `gh` calls. Steady-state smee-only traffic emits stdout lines without
  invoking `resolveEpic` / `runOnePoll` unless a completion signal arrives.

## Next Steps

- `/speckit:tasks` to generate task list from this plan.
