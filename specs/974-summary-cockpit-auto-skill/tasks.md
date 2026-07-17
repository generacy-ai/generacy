# Tasks: `generacy cockpit doorbell` verb

**Input**: Design documents from `/specs/974-summary-cockpit-auto-skill/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/cli-surface.md, contracts/subscribe-and-emit.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1: auto-driver wake latency, US2: skill drops watch)

## Phase 1: Setup

- [ ] T001 Add `.changeset/974-cockpit-doorbell.md` announcing a **minor** bump for `@generacy-ai/generacy` (new CLI subcommand = new public surface). Follow the shape of a comparable existing entry in `.changeset/`. Required by `.github/workflows/changeset-bot.yml`; must land in the implement PR (see CLAUDE.md "Changesets" section).

## Phase 2: Types and pure helpers (parallel — independent files)

- [ ] T002 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/doorbell/subscribe.ts` scaffold with the exported `lineForEvent(event: CockpitStreamEvent): string` pure translator per `contracts/subscribe-and-emit.md`. Return `` `${event.type}\n` `` for each of `issue-transition` / `phase-complete` / `epic-complete`. Import `CockpitStreamEvent` from `../watch/stream-event.ts`. No side effects.
- [ ] T003 [P] [US1] In `packages/generacy/src/cli/commands/cockpit/doorbell.ts` (new file) declare the internal `DoorbellOptions`, `DoorbellDeps`, `Form`, and `Rejection` types from `data-model.md §Types`. Export nothing yet beyond `doorbellCommand()` and `runDoorbell()` stubs; leave the bodies as `throw new Error('not implemented')` so the file compiles.
- [ ] T004 [P] [US1] In `doorbell.ts` add the private `classifyForm(positional: string | undefined, options: DoorbellOptions): Form | Rejection` pure helper per `data-model.md`. Truth-table matches `plan.md §Argv shape`: Form 1 (positional only), Form 2 (positional + `--tracking`), Form 3 (`--new` only), missing-positional rejection, conflicting-flags rejection. No I/O.

## Phase 3: `subscribeAndEmit` implementation

- [ ] T005 [US1] Implement `subscribeAndEmit(bus, options): unsubscribe` in `packages/generacy/src/cli/commands/cockpit/doorbell/subscribe.ts` per `contracts/subscribe-and-emit.md`:
  - Drive an internal `bus.waitFor({ sinceCursor, maxWaitMs, coalesceWindowMs, maxBatchSize })` loop starting at `sinceCursor: 0`.
  - For each returned entry: write `lineForEvent(entry.event)` to `options.stdout` with a completion callback, `await` the drain, advance the cursor, call `options.onEmit?.(entry.event)`.
  - Returned `unsubscribe()` aborts the internal loop and resolves any in-flight `waitFor` cleanly. Idempotent.
  - No stderr writes.
  - Reuse the `waitFor` protocol shape from `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts` — same call pattern `cockpit_await_events` uses.

## Phase 4: `runDoorbell` handler

- [ ] T006 [US1] In `packages/generacy/src/cli/commands/cockpit/doorbell.ts`, implement Commander definition `doorbellCommand()` matching `plan.md §Argv shape`:
  - `.argument('[epic-ref]', 'Epic ref (Form 1) or tracking-issue ref (Form 2). Omitted under --new.')`
  - `.option('--tracking', 'Positional is a tracking-issue ref; subscribe the tracking-ref bus.', false)`
  - `.option('--new <title>', 'No subscription; arm as a placeholder before the tracking issue exists.')`
  - `.option('--exit-on-epic-complete', 'Exit 0 after flushing the epic-complete line. Off by default.', false)`
  - `.description('Wake sensor for /cockpit:auto. Emits one stdout line per epic bus event.')`
- [ ] T007 [US1] In `runDoorbell(positional, options, deps)`, dispatch on `classifyForm(...)`:
  - Rejection `missing-positional` → stderr `cockpit doorbell: parse issue: issue argument is required`, exit 2 (via `deps.exit ?? process.exit`).
  - Rejection `conflicting-flags` (with positional) → stderr `cockpit doorbell: --new does not accept a positional argument`, exit 2.
  - Rejection `conflicting-flags` (`--tracking` + `--new`) → stderr `cockpit doorbell: --tracking and --new are mutually exclusive`, exit 2.
  - Error copy MUST match `contracts/cli-surface.md §Rejected argv combinations` character-for-character.
- [ ] T008 [US1] Form 1/2 branch in `runDoorbell`: call `deps.acquireBus ?? acquireEpicBus` with `{ epicRef: positional, runner: deps.runner ?? nodeChildProcessRunner, gh: deps.gh, rateLimitScheduler: deps.rateLimitScheduler, logger: deps.logger ?? stderrWarnLogger }`. On rejection, stderr `cockpit doorbell: <inner reason>`, exit 2 (matches `watch.ts:117`). On success, keep `release` for teardown.
- [ ] T009 [US1] After the acquire promise resolves under Form 1/2, write `armed\n` directly to `deps.stdout ?? process.stdout` with a drain callback (per `research.md §2` — out-of-band, NOT via `subscribeAndEmit`), then call `subscribeAndEmit(bus, { stdout: deps.stdout ?? process.stdout, onEmit: … })` to start the wake loop. Keep the returned `unsubscribe` closure for teardown.
- [ ] T010 [US1] Form 3 branch: no `acquireEpicBus`. Write `armed\n` to `deps.stdout ?? process.stdout` with drain callback (`research.md §2`) then `await`-block indefinitely on `SIGTERM`/`SIGINT`.
- [ ] T011 [US1] Signal handler wiring: `process.once('SIGINT', onStop)` and `process.once('SIGTERM', onStop)` per `plan.md §Signal handling`. `onStop`: call `unsubscribe()` (if defined), call `release()` (if defined — no-op under Form 3), drain stdout via `await new Promise(r => process.stdout.write('', () => r()))`, `deps.exit(0)`. Support `deps.abortSignal` as an additional stop trigger for tests.
- [ ] T012 [US2] Implement FR-011 `--exit-on-epic-complete` behavior in the Form 1 branch via the `onEmit` hook passed to `subscribeAndEmit`. When `event.type === 'epic-complete'` AND `options.exitOnEpicComplete` is true, drain stdout via `await new Promise(r => process.stdout.write('', () => r()))`, then `deps.exit(0)`. Mirror `watch.ts:217-225, 253` verbatim (per `research.md §4`). Under Form 2/3 the flag is a no-op (never receives `epic-complete`).

## Phase 5: Command registration

- [ ] T013 [US1] In `packages/generacy/src/cli/commands/cockpit/index.ts`, import `doorbellCommand` from `./doorbell.js` (mirror the sibling `import ... from './watch.js'` pattern) and register it on the cockpit group. Placement: alphabetical with the other `watch`/`status`/`resume`/… registrations. Update the header comment if it enumerates subcommands. Verified surface: `Available Commands:` in `generacy cockpit --help` MUST now include `doorbell` (per `contracts/cli-surface.md §Command name and group`).

## Phase 6: Tests

- [ ] T014 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/__tests__/doorbell.subscribe.test.ts` covering `contracts/subscribe-and-emit.md §Test surface`:
  - **T9** — hand-craft an `EpicEventBus`, `bus.emit()` three events, assert 3 stdout writes in order with correct `type`-word content (SC-003).
  - **T10** — `lineForEvent` isolated: exactly `issue-transition\n` / `phase-complete\n` / `epic-complete\n`, no JSON, no ref, no trailing whitespace (FR-005, Q3=B).
  - **T11** — call `unsubscribe()` mid-loop; assert no further writes after the returned promise resolves (FR-007 invariant).
  - Extra — `onEmit` hook fires exactly once per emitted event, after the stdout drain.
- [ ] T015 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/__tests__/doorbell.test.ts` covering `plan.md §Testing plan`:
  - **T1** — Form 1: `runDoorbell('owner/repo#5', {}, {acquireBus, stdout})` subscribes and emits one line per stubbed `bus.emit`, `armed\n` fires first.
  - **T2** — Form 2: `runDoorbell('owner/repo#5', {tracking: true}, deps)` forwards the positional to `acquireBus` unchanged.
  - **T3** — Form 3: `runDoorbell(undefined, {new: 'title'}, deps)` writes only `armed\n`, does NOT call `deps.acquireBus`.
  - **T4** — Missing positional (all flags off): exit 2, stderr `cockpit doorbell: parse issue: issue argument is required`.
  - **T5** — `--tracking` + `--new`: exit 2, stderr `cockpit doorbell: --tracking and --new are mutually exclusive`.
  - **T6** — SIGTERM path (use `deps.abortSignal` per T011): `unsubscribe()` and `release()` both called, `deps.exit(0)`.
  - **T7** — `--exit-on-epic-complete`: emit `epic-complete`, verify `deps.exit(0)` after drain.
  - **T8** — default post-`epic-complete`: without the flag, no exit; doorbell keeps polling.
  - Match error copy in `contracts/cli-surface.md §Rejected argv combinations` character-for-character.
- [ ] T016 [P] [US2] Create `packages/generacy/src/cli/commands/cockpit/__tests__/doorbell.refcount.test.ts` covering US2 acceptance criteria:
  - **T12** — inside the same process, two concurrent `acquireEpicBus({ epicRef, runCycle })` calls on the same ref share ONE poll loop. Use `runCycle` override to count invocations across a fixed simulated time window; assert count is identical to the one-subscriber case (SC-002, US2 AC-1).
  - **T13** — call `release()` on the first ref; assert the bus is still alive (subsequent `acquireEpicBus` on the same ref does NOT create a new one) while the second ref is held. Follow the existing refcount test patterns in `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/`.

## Phase 7: Verification

- [ ] T017 [US1] Run the full generacy CLI test suite (`pnpm --filter @generacy-ai/generacy test`) and confirm zero regressions in `packages/generacy/src/cli/commands/cockpit/__tests__/` and `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/` (SC-005). All new `doorbell*.test.ts` cases green.
- [ ] T018 [US1] Smoke-check `generacy cockpit --help` locally: assert `doorbell` appears in `Available Commands:`. Run `generacy cockpit doorbell --help` and assert exit code 0 with a usage banner listing `<epic-ref>`, `--tracking`, `--new <title>`, `--exit-on-epic-complete` (`contracts/cli-surface.md §--help probe`; SC-001 preview-cluster smoke defers to post-preview-build validation but the local `--help` shape is verifiable now).

## Dependencies & Execution Order

**Sequential phases** (must complete in order):
- Phase 1 (changeset) → landing PR gate; can be authored anytime before merge but MUST exist in the diff.
- Phase 2 (types + pure helpers) → Phase 3 (`subscribeAndEmit` depends on `lineForEvent` from T002).
- Phase 3 → Phase 4 (`runDoorbell` calls `subscribeAndEmit`).
- Phase 4 → Phase 5 (registration wires `doorbellCommand` into the group; command must exist first).
- Phase 5 → Phase 6 (tests import and drive the handler).
- Phase 6 → Phase 7 (verification observes assembled state).

**Parallel opportunities within phases**:
- T002, T003, T004 in Phase 2 are `[P]` — three independent file/section edits.
- T014, T015, T016 in Phase 6 are `[P]` — three independent test files.

**Cross-phase parallelism**:
- T001 (changeset) has no code dependency and can run in parallel with any phase.

**Critical path**: T002 → T005 → T008/T009 → T012 → T013 → T015 → T017.

---

*Generated by speckit from `plan.md`, `data-model.md`, `contracts/cli-surface.md`, `contracts/subscribe-and-emit.md`, `research.md`.*
