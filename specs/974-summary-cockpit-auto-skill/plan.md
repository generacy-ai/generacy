# Implementation Plan: `generacy cockpit doorbell` verb

**Feature**: Add the missing `doorbell` subcommand under `generacy cockpit` — a self-contained CLI wake-sensor that constructs its own in-process refcounted `EpicEventBus` (via `acquireEpicBus`), emits one newline-terminated stdout marker per `bus.emit()`, and runs until SIGTERM (with opt-in `--exit-on-epic-complete`). Unblocks the `/cockpit:auto` skill (agency#431), which arms `generacy cockpit doorbell <epic-ref>` as its background wake-sensor but today gets `error: unknown command 'doorbell'` and silently degrades to 5-min heartbeat polling.
**Branch**: `974-summary-cockpit-auto-skill`
**Status**: Complete

## Summary

The `doorbell` verb is a small, self-contained CLI sensor. Its whole reason to exist is that the `/cockpit:auto` skill's `Monitor` calls `generacy cockpit doorbell …` expecting one line of stdout per epic transition. Today the command doesn't exist, so auto silently degrades to the 5-min `ScheduleWakeup` fallback.

The Q1=C clarification pins the architecture: the doorbell runs its **own** `acquireEpicBus()` in-process — it does **not** attach to the MCP server's bus. The cockpit MCP server is stdio-only (`mcp/index.ts` uses `StdioServerTransport`) and serves exactly one client; a separately-spawned CLI process cannot share its bus. So the design is: one CLI process → one `acquireEpicBus` call → one bus + one poll loop → stdout markers. `#970` already de-risked the doubled poll cost via short-TTL GraphQL cache, rate-limit backoff, and lifecycle-gated check polling.

The verb takes three arming forms mirroring `auto.md:53`:
- **Form 1**: `doorbell <epic-ref>` — subscribes epic bus.
- **Form 2**: `doorbell <tracking-ref> --tracking` — subscribes tracking-ref bus (same `acquireEpicBus`, different key).
- **Form 3**: `doorbell --new "<title>"` — no subscription; emits only the FR-010 `armed\n` line, blocks on SIGTERM.

Per-line content (Q3=B): each line is the event `type` word (`issue-transition`, `phase-complete`, `epic-complete`); FR-010 initial line is the constant `armed`. Emitted 1:1 with `bus.emit()`, no filter (Q4=A). `--exit-on-epic-complete` mirrors `watch.ts:217-225, 253` — off by default (Q5=B).

`acquireEpicBus` already lives in `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` and today is only wired to the MCP server. It is process-agnostic by construction — the registry is a plain module-scoped `Map` — so the doorbell process simply calls it from a new command file. No refactor of `event-bus-registry.ts` is required beyond adding a callsite from the CLI verb (Assumptions §3 in spec).

## Technical Context

- **Language/Version**: TypeScript (ESM, Node >=22)
- **Primary Dependencies**: `commander` (existing subcommand pattern), `@generacy-ai/cockpit` (for `GhCliWrapper` + `createRateLimitScheduler` + `createGhResponseCache` + `nodeChildProcessRunner`) — all already imported by `watch.ts` and reused here.
- **Package touched**: `packages/generacy/` only. No changes to `packages/cockpit/`.
- **Test runner**: Vitest — matches existing convention in `packages/generacy/src/cli/commands/cockpit/__tests__/`.
- **Storage**: None. The verb is stateless per invocation; `EpicEventBus` state lives in `event-bus-registry.ts`'s module-scoped `Map` for the doorbell process's lifetime.
- **Performance goals**: SC-004 — auto-drive latency from real epic transition to skill wake drops from 5-min fallback to `<= 60s` p95 (poll cadence + emit). Verified on a preview cluster during a synthetic `/cockpit:auto` run.
- **Constraints**:
  - Must not regress `cockpit watch` or `cockpit_await_events` (SC-005).
  - Must not parse stdout content in the caller (spec Out of Scope §4); content is deterministic for testability but not a caller contract.
  - Must not attempt cross-process bus attach (Q1=C, spec Out of Scope §5).
  - stdout is reserved for wake signals only; poll errors + resolve failures go to stderr (FR-009).

## Constitution Check

No `.specify/memory/constitution.md` in repo. Skipped.

Existing project conventions honoured:
- **Changeset required** (`.github/workflows/changeset-bot.yml`) — this diff touches non-test files under `packages/generacy/src/`. The `implement` phase must add `.changeset/974-*.md` listing `@generacy-ai/generacy` at bump level `minor` (new CLI subcommand = new public surface).
- **No comments describing WHAT** — the verb's shape mirrors `watch.ts` intentionally; only `Why:` comments where the constraint isn't obvious (Q1=C rationale on the in-process `acquireEpicBus` call, FR-006 flush rationale on non-TTY stdout).
- **No new inter-process signal** — the doorbell owns its own bus in-process (Q1=C).
- **Vitest, no snapshot fixtures** — matches existing `packages/generacy/src/cli/commands/cockpit/__tests__/*.test.ts` style.
- **Reuse `resolveIssueContext`** — per #822/#850, no direct `parseIssueRef` calls from cockpit verbs. Ref grammar goes through the shared resolver.

## Project Structure

```
packages/generacy/src/cli/commands/cockpit/
  index.ts                                     MOD  — register the new `doorbellCommand()` in the
                                                      `cockpit` group alongside watch/status/…
                                                      (one line added; header comment updated).
  doorbell.ts                                  NEW  — CLI verb. Commander definition + async
                                                      `runDoorbell(epicRef, options, deps)` handler
                                                      (deps-injection shape mirrors `runWatch`).
                                                      Owns:
                                                        - argv shape parse (Form 1/2/3 dispatch),
                                                        - `--tracking` / `--new` / `--exit-on-epic-complete`
                                                          flag decode,
                                                        - `acquireEpicBus` callsite,
                                                        - bus.subscribe → stdout writer,
                                                        - flushed writes (FR-006),
                                                        - SIGTERM/SIGINT `release()` + exit 0 (FR-007),
                                                        - FR-010 `armed\n` line after initial-poll settles
                                                          (or immediately on Form 3),
                                                        - FR-011 opt-in exit on `epic-complete`.
  doorbell/
    subscribe.ts                               NEW  — pure function `subscribeAndEmit(bus, stdout,
                                                      opts): unsubscribe`. Wires bus.on('event', …)
                                                      to the stdout writer, translating the event
                                                      union to its `type` word (Q3=B). Returns the
                                                      unsubscribe closure. Isolated so tests can
                                                      exercise it without a running poll loop.
  __tests__/
    doorbell.test.ts                           NEW  — verb-level test cases (see below).
    doorbell.subscribe.test.ts                 NEW  — `subscribeAndEmit` in isolation:
                                                        - emits one line per bus.emit() (SC-003),
                                                        - line content matches event `type` (FR-005),
                                                        - unsubscribe stops writes.
    doorbell.refcount.test.ts                  NEW  — two concurrent `acquireEpicBus()` inside the
                                                      same process share ONE poll loop (SC-002),
                                                      release semantics preserved (US2 AC-2).

.changeset/
  974-cockpit-doorbell.md                      NEW  — minor bump on `@generacy-ai/generacy` (new CLI
                                                      subcommand). Written during the implement phase.
```

### Why a `doorbell/subscribe.ts` sibling module

Separating `subscribeAndEmit` from the Commander glue in `doorbell.ts` lets us:
- test the "one line per event, event.type word only" contract without instantiating the poll loop (`noPoll: true` on `acquireEpicBus` still requires an `EpicEventBus`, but a hand-emitted bus is simpler and more focused);
- keep `doorbell.ts` a thin argv-and-lifecycle shell that mirrors `watch.ts`'s shape.

The alternative (inline in `doorbell.ts`, no sibling) was considered — see `research.md` §1.

## Argv shape

Commander definitions:

```ts
new Command('doorbell')
  .description('Wake sensor for /cockpit:auto. Emits one stdout line per epic bus event.')
  .argument('[epic-ref]',
    'Epic ref (Form 1) or tracking-issue ref (Form 2). Omitted under --new.')
  .option('--tracking',
    'Positional is a tracking-issue ref; subscribe the tracking-ref bus.', false)
  .option('--new <title>',
    'No subscription; arm as a placeholder before the tracking issue exists.')
  .option('--exit-on-epic-complete',
    'Exit 0 after flushing the epic-complete line. Off by default.', false)
```

Dispatch (`runDoorbell`):

| Form | positional | `--tracking` | `--new` | Behavior |
|------|------------|--------------|---------|----------|
| 1 | present | false | absent | `acquireEpicBus(<positional>)`; subscribe; `armed\n`; run until SIGTERM (or `--exit-on-epic-complete`). |
| 2 | present | true | absent | `acquireEpicBus(<positional>)` — same call, different key. Same subscription pattern. `epic-complete` never fires so FR-011 is a no-op. |
| 3 | absent | false | present | No `acquireEpicBus`. Write `armed\n`, flush, block on SIGTERM. |
| — | absent | any | absent | Reject: `cockpit doorbell: parse issue: issue argument is required` → exit 2 (FR-002, matches `watch`). |
| — | any | true | present | Reject: `cockpit doorbell: --tracking and --new are mutually exclusive` → exit 2. |

Ref parsing under Form 1/2 goes through `resolveIssueContext` (transitively — `acquireEpicBus` already calls it via `expandRef`). No direct `parseIssueRef` call from `doorbell.ts` (satisfies the #850 ESLint guard).

## Stdout contract (FR-005, FR-006, FR-010, Q3=B)

- One `process.stdout.write('<type>\n')` per emitted event.
- After each write, drain: `await new Promise(r => process.stdout.write('', () => r()))` — same idiom `watch.ts:222-224` uses under `--exit-on-epic-complete`. This is the FR-006 flush; without it, Node's block-buffered stdout defeats the wake signal when the doorbell is spawned by `Monitor` (pipe, not TTY).
- FR-010 `armed\n` is emitted **out-of-band** (not via `bus.emit()`), after the initial poll settles. Detection: hook the first `bus.emit()` OR resolve on the initial `runOnePoll` completion. Approach chosen: use `acquireEpicBus`'s internal "first poll" signal — see `research.md` §2.

## Signal handling (FR-007)

- Register `process.once('SIGINT', onStop)` and `process.once('SIGTERM', onStop)`, matching `watch.ts:150-151`.
- `onStop` calls `release()` (returned by `acquireEpicBus`), removes the bus subscription, drains stdout, exits 0.

## Error surface (FR-002, FR-009)

- Missing positional (Forms 1/2) → stderr `cockpit doorbell: parse issue: issue argument is required` → exit 2.
- `--tracking` and `--new` together → stderr `cockpit doorbell: --tracking and --new are mutually exclusive` → exit 2.
- `resolveIssueContext` failure → stderr `cockpit doorbell: <inner reason>` → exit 2 (matches `watch.ts:117`).
- Poll errors bubble through `event-bus-registry.ts`'s internal `logger.warn(…)` → stderr. The doorbell keeps running (bus-level poll error is not fatal). Same as `watch`.

## Testing plan

`packages/generacy/src/cli/commands/cockpit/__tests__/doorbell.test.ts`:
- **T1 — Form 1 subscribes and emits**: hand-craft an `EpicEventBus`, inject via `acquireEpicBus` seam (`noPoll: true`, then `bus.emit(...)`); assert one stdout line per emit, content is `type` word.
- **T2 — Form 2 same shape as Form 1**: verify the doorbell forwards the `--tracking` positional through `acquireEpicBus` unchanged (keying is bus-registry's concern).
- **T3 — Form 3 armed-only**: `--new "title"` → one `armed\n` line then blocks; no bus acquire.
- **T4 — Missing positional**: exit 2, stderr `cockpit doorbell: parse issue: issue argument is required`.
- **T5 — `--tracking` + `--new` conflict**: exit 2, stderr message.
- **T6 — SIGTERM shuts down cleanly**: emit sends `SIGTERM`, doorbell exits 0, `release()` called.
- **T7 — `--exit-on-epic-complete`**: emit `epic-complete`, verify doorbell exits 0 after flushing.
- **T8 — Default post-`epic-complete` behavior**: without the flag, after `epic-complete` the doorbell keeps running.

`packages/generacy/src/cli/commands/cockpit/__tests__/doorbell.subscribe.test.ts`:
- **T9 — 1:1 emit to line** (SC-003).
- **T10 — Line content is `type` word only** (FR-005, Q3=B).
- **T11 — Unsubscribe stops writes** (FR-007 invariant).

`packages/generacy/src/cli/commands/cockpit/__tests__/doorbell.refcount.test.ts`:
- **T12 — Two in-process acquires, one poll loop** (SC-002 in-process assertion, US2 AC-1). Uses `noPoll: false` + `runCycle` override to count poll invocations.
- **T13 — First `release()` does not tear down bus while second ref held** (US2 AC-2). Follows `mcp/__tests__` refcount patterns.

Every existing `packages/generacy/src/cli/commands/cockpit/__tests__/` and `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/` test stays green (SC-005). Zero changes to `event-bus-registry.ts`, `event-bus.ts`, `watch.ts`, or the MCP server — this is additive.

## Manual verification (SC-001, SC-004)

- **SC-001 preview-cluster smoke**: after a preview build ships, run `generacy cockpit doorbell --help` inside the cluster; expect exit 0 and usage output listing `doorbell` in `generacy cockpit --help`.
- **SC-004 latency**: run `/cockpit:auto` against a synthetic epic on the preview cluster. Force one label transition on a scoped issue and observe skill wake latency. Baseline is the pre-#970 5-min heartbeat; the target is `<= 60s` p95 (30 s poll cadence + emit + skill processing).

## Follow-ups (out of scope for this spec)

- Cross-process poll-collapse (agency#431's "one poll loop per epic") requires a new IPC surface — either a doorbell-owned Unix socket the MCP server dials, or a control-plane-hosted daemon both processes attach to. Tracked as Q1 option B; deferred until the 2× (doorbell + `cockpit_await_events`) proves material.
- Removing `generacy cockpit watch` — stays for interactive/human use (spec Out of Scope §2).
- Hardening the skill's `--help` pre-flight probe to distinguish "verb present" from "verb absent under a parent group" — companion agency-side issue.

## Suggested next step

`/speckit:tasks` to generate the task list.
