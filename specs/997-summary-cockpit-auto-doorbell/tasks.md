# Tasks: Doorbell survives smee loss + quiet windows

**Input**: Design documents from `/specs/997-summary-cockpit-auto-doorbell/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/doorbell-bridge-mode.md, contracts/source-selector-bridge.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = long quiet window; US2 = transient smee outage; US3 = dead-but-open stream)

## Phase 1: Selector core (state machine + type surface)

- [X] T001 [US1][US2][US3] Update `packages/generacy/src/cli/commands/cockpit/doorbell/source-selector.ts`:
  - Change `DEFAULT_DEMOTE_AFTER_MS_WITHOUT_SUCCESS` from `300_000` to `90_000` (research D2).
  - Widen `SourceReason` union with `'startup-smee-failed'` (data-model → Public types).
  - Add public method `onSseBytes(): void` — no-op unless `_current === 'smee-active'` and not `stopped`; refreshes `lastSuccessfulConnectAt = this.now()`. Never emits stderr, never fires mode-change callbacks (contract source-selector-bridge § `onSseBytes()`).
  - Add public method `markStartupSmeeFailed(): void` — no-op unless `_current === 'smee-attempt'` and not `stopped`; calls `this.transition('poll-fallback', 'startup-smee-failed')`. Rely on the existing `transition()` path to start `rePromoteTimer` when `initialWasSmee === true` (contract § `markStartupSmeeFailed()`).
  - Extend `onReconnectSuccess()`: add a new branch for `_current === 'poll-fallback'` — clear `rePromoteTimer` if set, then `this.transition('smee-active', 'smee-re-promoted')`. Do NOT alter the existing `smee-attempt` / `smee-active` branches (contract § `onReconnectSuccess()` — extended).
  - Preserve all existing invariants: no self-loop transitions, `stopped` short-circuit on every public method, exactly one stderr line per non-silent transition.

## Phase 2: Byte-liveness in the smee source

- [X] T002 [US1][US3] Update `packages/generacy/src/cli/commands/cockpit/doorbell/smee-source.ts`:
  - Widen `SmeeDoorbellSourceOptions` with `onSseBytes?: () => void` (optional, unset-safe).
  - Store on class as `private readonly onSseBytes?: () => void`; assign in constructor if provided.
  - In `connect()`'s reader loop, after each `reader.read()` that returns `value != null && value.length > 0`, invoke `this.onSseBytes?.()` inside a `try/catch { /* swallow */ }` (same pattern as `onReconnectAttempt` / `onReconnectSuccess`).
  - No other behavioural change; the reconnect ladder (owned by #991) is untouched.

## Phase 3: Doorbell wiring (bridge open / bridge exit / startup fall-through)

- [X] T003 [US1][US2][US3] Update `packages/generacy/src/cli/commands/cockpit/doorbell.ts`:
  - In `runSmeeMode`, add `onSseBytes: () => input.selector.onSseBytes()` alongside `onReconnectAttempt` / `onReconnectSuccess` in the `sourceOptions` object (contract doorbell-bridge-mode § `runSmeeMode` wiring change).
  - Rewrite the `selector.onModeChange` handler:
    - `next === 'poll-fallback'` → **REMOVE** the `await s.source.stop()` call (this is the core bug). Fire-and-forget `startPollMode()`; on `permanent-exit` set `permanentExit = true` and `stop()`; on `transient-fail` call `stop()`; on `ok` leave `smeeHandle` alive so `SmeeDoorbellSource.runLoop` keeps reconnecting in the background.
    - `next === 'smee-active'` (NEW branch) → release `pollHandle` if set (`p.release()`, `pollHandle = null`); leave `smeeHandle` alone. Never call `stop()` from this branch.
    - `next === 'smee-attempt' && discovery != null` — retain existing shape (rePromoteTimer path); release `pollHandle`, then `startSmeeMode(discovery.url)` with nested `startPollMode()` fallback on `transient-fail`.
  - At the startup fall-through in `runDoorbell()` (roughly line 533), when `startSmeeMode(discovery.url)` returns `transient-fail`, call `selector.markStartupSmeeFailed()` **before** the subsequent `startPollMode()` (contract § Startup fall-through path). Existing outcome handling below unchanged.

## Phase 4: Test coverage

- [X] T004 [US1][US2][US3] Update `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/source-selector.test.ts`:
  - Adjust the existing "5th reconnect attempt demotes" test: assert the transition target is still `poll-fallback` with reason `smee-runtime-lost`. Selector-level state is unchanged; terminal-vs-bridge is a doorbell concern verified in T005.
  - Update the existing "observeElapsed past window demotes" test to the new `90_000` ms threshold.
  - Add case (a): `onSseBytes()` refreshes `lastSuccessfulConnectAt`, so an `elapsedTicker` tick past `90_000` ms after the LAST `onSseBytes()` triggers demotion, but frequent `onSseBytes()` calls (e.g. every 30 s of virtual time for ≥60 min) never demote.
  - Add case (b): after entering `smee-active`, stop calling `onSseBytes()`; advance fake time past 90 s; `elapsedTicker` fires; assert transition to `poll-fallback` with reason `smee-runtime-lost`.
  - Add case (c): from `poll-fallback` (however arrived), `onReconnectSuccess()` transitions to `smee-active` with reason `smee-re-promoted`; assert `rePromoteTimer` is cleared and one stderr line is emitted.
  - Add case (d): from `smee-attempt`, `markStartupSmeeFailed()` transitions to `poll-fallback` with reason `startup-smee-failed`; assert the new stderr line, mode-change callbacks fire once, and `rePromoteTimer` is armed. From any other `_current`, `markStartupSmeeFailed()` is a no-op.
  - Use `vi.useFakeTimers()` for time-driven cases per the sibling precedent at `source-selector.test.ts:91-127`.

- [X] T005 [P][US1][US2][US3] Create `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/doorbell-bridge.test.ts` (NEW file):
  - Use `vi.useFakeTimers()` to drive both `Date.now()` (`vi.setSystemTime`) and the `elapsedTicker` interval together.
  - Drive `runDoorbell()` through an injected `sourceSelectorFactory` + `smeeSourceFactory`; the stub smee source exposes `onSseBytes` / `onReconnectAttempt` / `onReconnectSuccess` for deterministic scripting.
  - Scenario FR-007(a) — ≥60-min quiet-but-alive smee: enter `smee-active`, invoke `onSseBytes` on a ~30 s cadence in fake time for ≥60 min. Assert no `poll-fallback` transition, no `stop()` call, stdout stream stays open, no `permanent-exit`.
  - Scenario FR-007(b) — keepalives stop mid-run: enter `smee-active`, invoke `onSseBytes` a few times, then stop calling it; advance fake time past 90 s. Assert `poll-fallback` transition with `smee-runtime-lost`, `startPollMode()` opens (bridge), smee source is NOT stopped, stdout stream stays open.
  - Scenario FR-007(c) — N reconnect failures during a smee.io drop: enter `smee-active`, drive `onReconnectAttempt(n)` up through `DEFAULT_DEMOTE_AFTER_FAILURES`. Assert bridge opens (`poll-fallback`), smee source stays alive. Then invoke `onReconnectSuccess()`; assert direct transition to `smee-active` with `smee-re-promoted`, poll bridge is released, stdout stream stays open.
  - SC-004 audit: across all three scenarios, assert `stdout.write`s never terminate mid-run (no code path emits the poll snapshot AND ends the stream).

## Phase 5: Changeset (CI gate) and verification

- [X] T006 [P] Create `.changeset/997-doorbell-bridge-mode.md` (NEW file):
  - `patch` bump for `@generacy-ai/generacy` (defect fix per CLAUDE.md rules; no new public API surface).
  - Under `workflow:speckit-bugfix` — this is a bug fix, not a new capability.
  - Body: one sentence explaining that runtime demotion in the cockpit doorbell is now a non-terminal live bridge that keeps the sensor stdout stream open across smee.io outages and quiet windows.
  - Must be a NEWLY ADDED file in the PR diff (the CI gate greps `--diff-filter=A` against the base).

- [X] T007 Run local verification before pushing:
  - `pnpm --filter @generacy-ai/generacy typecheck` — confirm the new `SourceReason` value, new selector methods, and new option field type-check.
  - `pnpm --filter @generacy-ai/generacy test` — confirm both the modified `source-selector.test.ts` and the new `doorbell-bridge.test.ts` pass, plus the unmodified `smee-source-reconnect.test.ts` and `doorbell.test.ts` still pass (no regression in the reconnect ladder or arg-parsing paths).
  - `pnpm changeset status` (reads directory, not git) — confirm the new `997-doorbell-bridge-mode.md` is recognised.

## Dependencies & Execution Order

**Sequential**:
- T001 (selector) → T004 (selector unit tests need the new methods to exist).
- T001 + T002 (source) → T003 (doorbell wires both).
- T001 + T002 + T003 → T005 (bridge integration test needs the full wiring).
- All source edits (T001–T003) → T007 (verification).

**Parallel opportunities**:
- T005 (new file) is `[P]` — can be authored alongside T004 once the selector/source APIs from T001+T002 are settled.
- T006 (changeset) is `[P]` — no code dependency; can be authored any time before T007.

**Suggested execution**:
1. T001, then T002 (independent files, either order works; both must land before T003).
2. T003 (doorbell wiring — depends on T001 + T002).
3. T004 and T005 in parallel (both depend on the T001–T003 API surface being stable).
4. T006 anywhere from step 1 onward.
5. T007 last (typecheck + tests + changeset presence).
