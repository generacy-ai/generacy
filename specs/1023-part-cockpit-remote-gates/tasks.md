# Tasks: Cockpit doorbell — tail answers file → gate-answer events

**Input**: Design documents from `/specs/1023-part-cockpit-remote-gates/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/answers-file-source.md, contracts/gate-answer-event.md, contracts/gate-answer-line.md, quickstart.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: All tasks trace to the single US in spec §Scope — "the doorbell tails `/workspaces/.generacy/cockpit/answers.ndjson` and emits `gate-answer` events to both wake paths." Tagged `[US1]` for that single story.

## Phase 1: Schemas & Union Extension

The tailer, its unit tests, and the doorbell wiring all import from these two files, so they land first.

- [X] T001 [US1] Create `packages/generacy/src/cli/commands/cockpit/watch/gate-answer.ts` with:
  - `GateAnswerLineSchema` — Zod object, `.passthrough()`, fields per contracts/gate-answer-event.md and data-model §E-1: required `gateId`/`deliveryId`/`scope`/`answer`/`answeredAt`; optional `answeredBy`/`generation`.
  - `GateAnswerEventSchema` — Zod object with `type: z.literal('gate-answer')`, `ts` (ISO datetime), `gateId`, `deliveryId`, `epic` (regex `^[^/]+\/[^/]+#\d+$`), `line: GateAnswerLineSchema`.
  - Exported types `GateAnswerLine` and `GateAnswerEvent` via `z.infer`.
  - No mapping helper needed on file creation — the tailer will build events inline in T003.

- [X] T002 [US1] Modify `packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts`: add `GateAnswerEventSchema` as the fourth arm of the `discriminatedUnion('type', […])`. Import from `./gate-answer.js`. No changes to existing arms. Preserve export names (`CockpitStreamEventSchema`, `CockpitStreamEvent`) so downstream consumers pick up the new variant transparently.

## Phase 2: Tailer Implementation

Depends on Phase 1 (imports schemas from `watch/gate-answer.ts`).

- [X] T003 [US1] Create `packages/generacy/src/cli/commands/cockpit/doorbell/answers-file-source.ts` implementing the contract in `contracts/answers-file-source.md`:
  - Export `class AnswersFileSource` with `constructor(options: AnswersFileSourceOptions)`, `start(): Promise<void>`, `stop(): Promise<void>`, `getState()`.
  - Export `interface AnswersFileSourceOptions` per data-model §E-3 (all seams present: `epicRef`, `filePath?` default `/workspaces/.generacy/cockpit/answers.ndjson`, `onEvent`, `logger`, `replayLineCap?` default 10 000, `pollIntervalMs?` default 2 000, `useFsWatch?` default `true`, `now?`, `fs?`).
  - Constructor validation per data-model §E-3: `epicRef` matches `^[^/]+\/[^/]+#\d+$`, `replayLineCap > 0 || === Infinity`, `pollIntervalMs >= 100`. Throw synchronously on violation.
  - Private `TailerState` per data-model §E-4 — internal only, not exported.
  - State machine transitions per contract Lifecycle table: `waiting-for-dir` → `waiting-for-file` → `replaying` → `tailing`, with rotation/truncation loops back to `replaying`, and `stop()` → `stopped` from any state.
  - Hybrid tail mechanism per plan D-1: `fs.watch` on the parent dir when `useFsWatch === true`, plus a `setInterval(pollIntervalMs)` safety-net; on each fire, `stat()` and compare `(ino, size)` to the last observed pair. Growth → read `[lastSize..newSize]`. `ino` change or `size < lastSize` → treat as rotation: reopen at offset 0, re-enter `replaying`.
  - Startup replay per plan D-2: two-pass line count. First pass counts total lines; if `count > replayLineCap`, second pass skips the first `count - replayLineCap` lines and emits one `logger.warn` with the `[skippedFromByte, skippedToByte]` range and skipped line count per contract Logging table. Under the cap → emit all lines in file order.
  - Per-line pipeline for every line (replay AND live-tail): (a) `JSON.parse` — on failure, `logger.warn` with file path, byte offset at line start, and best-effort extracted `gateId`; skip. (b) `GateAnswerLineSchema.safeParse` — on failure, same `logger.warn` shape; skip. (c) Epic scope filter — compare `line.scope` (`owner/repo#number`) against parsed `epicRef`; on mismatch, `logger.info` with file path, byte offset, `gateId`, source `scope`, bound `epicRef`; drop. (d) Build `GateAnswerEvent` per data-model §E-2 (`ts = new Date(now()).toISOString()`, `gateId`/`deliveryId` hoisted from `line`, `epic = epicRef`, `line` verbatim). (e) `await onEvent(event)` — backpressure per emit-contract §Backpressure.
  - Rotation-info log per contract Logging table: on `ino` change → `logger.info` with file path + old ino + new ino. On size-shrink truncation → `logger.info` with path + ino + old size + new size.
  - `stop()` idempotent: sets `running = false`, calls `fsWatchAbort.abort()`, clears `pollTimer`, closes any open file handle, transitions state to `stopped`. Guarded against emit-after-stop per contract Cross-Entity Invariant §5.
  - Zero direct `process.stderr.write` / `process.stdout.write` — logging goes through injected `logger` only per contract §Logging.

## Phase 3: Doorbell Wiring

Depends on Phase 2 (constructs `AnswersFileSource`).

- [X] T004 [US1] Modify `packages/generacy/src/cli/commands/cockpit/doorbell.ts`:
  - Import `AnswersFileSource` from `./doorbell/answers-file-source.js`.
  - After parsing `epicRef` (existing code around `:98-101`), instantiate `new AnswersFileSource({ epicRef, onEvent: <bridge>, logger, now })` in both `runSmeeMode` and `runPollMode` branches — the tailer runs in parallel with whichever primary source `source-selector` picks (per plan §Summary invariant "answers tailer runs concurrently under whatever source the selector reports").
  - `<bridge>` is a callback that (a) calls the shared stdout writer `lineForEvent(event)` (same path smee/poll use — `doorbell/subscribe.ts:22`) and (b) calls `bus.emit(event)` on the same `EpicEventBus` instance the primary source uses. Do NOT introduce a new stdout serialisation path — reuse `lineForEvent`.
  - Register the tailer's `stop()` in the existing SIGINT/SIGTERM shutdown path so it stops cleanly alongside `SmeeDoorbellSource`.
  - No changes to `source-selector` — the tailer is a peer producer, not a selector state (per research R-1).
  - No new CLI flags (per quickstart §Operator usage).

## Phase 4: Tests

Depends on Phases 1–3 (imports schemas, constructs tailer, exercises wiring).

- [X] T005 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/answers-file-source.unit.test.ts` — pure schema + line-pipeline unit coverage (no real filesystem). Use the `fs` façade seam. Cases mirror contracts/gate-answer-line.md §Test cases:
  - Happy path: valid line matching `epicRef` → one `onEvent` call with correct `GateAnswerEvent` shape (round-trip through `CockpitStreamEventSchema.parse(JSON.parse(lineForEvent(event)))` returns equivalent event — contract §Invariants §3).
  - Missing `gateId` / missing `scope.number` / empty-string `gateId` / `scope.number` as string → skipped with `logger.warn`, no `onEvent`.
  - Malformed JSON (line is not valid JSON) → skipped with `logger.warn` including byte offset.
  - Extra unknown fields on the line → preserved on `event.line[unknownField]` via `.passthrough()` (contract §Invariants §4).
  - Cross-epic line (`scope` does not match bound `epicRef`) → dropped with `logger.info` including `gateId`, source `scope`, bound `epicRef`; no `onEvent`.
  - Constructor validation: `epicRef` regex, `replayLineCap > 0`, `pollIntervalMs >= 100` — all three throw synchronously.
  - `event.ts` uses the injected `now()` clock (deterministic).

- [X] T006 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/answers-file-source.tail.test.ts` — filesystem-level tail + rotation coverage. Use a real temp dir (`node:fs/promises.mkdtemp`) so `fs.watch` and `stat` behave naturally. Set `pollIntervalMs` low (e.g., 50 ms) for fast suites.
  - Dir-then-file appearance: start tailer with parent dir absent → state `waiting-for-dir`; `mkdir` parent → state `waiting-for-file`; write file → state transitions through `replaying` to `tailing` and consumes the initial line.
  - Live append: write file with 1 line → tailer emits; append another line → tailer emits second event; assert byte-order of emits equals file-append order (contract §Emit Contract Order guarantee).
  - Rotation (unlink + rewrite): unlink file, create new file with different inode, write a fresh line → tailer emits one `logger.info` rotation entry (old ino + new ino) and re-enters `replaying`, then emits the new line.
  - Truncation (`fs.truncate` or open + write): file same inode, size shrank → tailer emits one `logger.info` truncation entry (ino + old size + new size) and reopens at offset 0.
  - `stop()` while `tailing`: subsequent appends produce zero emits; second `stop()` call is a no-op; `getState() === 'stopped'`.

- [X] T007 [P] [US1] Create `packages/generacy/src/cli/commands/cockpit/doorbell/__tests__/answers-file-source.replay.test.ts` — startup replay + cross-source interleave coverage. Prefer the `fs` façade seam over real fs so timing is deterministic; use `useFsWatch: false` per contract §Test Seams.
  - Cap enforcement: pre-populate file with 15 lines, set `replayLineCap: 10` → exactly 10 `onEvent` calls (the last 10 in file order); one `logger.warn` with `[skippedFromByte, skippedToByte]` naming the head 5 lines and skipped count = 5.
  - Cap not hit: pre-populate with 3 lines, default cap → 3 `onEvent` calls; no cap-truncation warn.
  - `replayLineCap: Infinity` disables the cap — replay all lines regardless of count.
  - Cross-source interleave (Q3 → A / research R-7): construct a fake smee source that emits `issue-transition` events into the same `bus` while startup replay is draining → assert the bus receives both event types interleaved (no drain barrier). Cursor monotonicity is the only ordering guarantee, per plan §Constitution Re-Check.
  - Replay ordering: pre-populated lines emit in file-append order (byte offset).

- [X] T008 [US1] Modify `packages/generacy/src/cli/commands/cockpit/__tests__/doorbell.test.ts` — extend existing doorbell suites per plan §Modified — tests that need extension. Add cases covering:
  - `runSmeeMode`: assert `AnswersFileSource` is constructed with the correct `epicRef` and started.
  - `runPollMode`: same assertion — the tailer runs in both modes.
  - SIGINT: assert `AnswersFileSource.stop()` is invoked alongside `SmeeDoorbellSource.stop()`; no emit-after-stop.
  - Use test doubles for `AnswersFileSource` (constructor spy) — do not exercise the real tailer here; T005–T007 own that.

## Phase 5: Changeset & Verification

- [X] T009 [US1] Create `.changeset/1023-cockpit-doorbell-answers-tailer.md` per CLAUDE.md gate and plan §Constitution Check:
  - Bump `@generacy-ai/generacy` **minor** (new capability: `gate-answer` event variant + tailer wake source surfaced by the shared `CockpitStreamEvent` union that other consumers parse).
  - Only `@generacy-ai/generacy/src/` is touched — no other package needs a bump.
  - Copy the shape of a comparable existing changeset in `.changeset/` (see CLAUDE.md).
  - Verify the file appears as `--diff-filter=A` in the PR diff (a newly added file, not an edit of an existing one) so the changeset-bot gate passes.

- [X] T010 [US1] Run the full package test + typecheck locally and confirm green before pushing:
  - `pnpm --filter @generacy-ai/generacy test` — passes T005/T006/T007/T008.
  - `pnpm --filter @generacy-ai/generacy build` — clean.
  - `pnpm --filter @generacy-ai/generacy typecheck` — no diagnostics from the extended discriminated union.
  - Manual smoke (optional, per quickstart §Troubleshooting): `generacy cockpit doorbell owner/repo#123` against a temp answers file — append one valid line → observe one `{type:"gate-answer",…}` line on stdout within ~2 s (poll fallback bound).

## Dependencies & Execution Order

**Sequential dependencies**:

1. **Phase 1 → Phase 2**: T001 (`gate-answer.ts` with schemas) must land before T003 (tailer imports the schemas). T002 (`stream-event.ts` union extension) can land in parallel with T003 but before T004 (`doorbell.ts` wiring, which relies on the extended union type-checking cleanly).
2. **Phase 2 → Phase 3**: T003 (tailer class) must land before T004 (doorbell wiring constructs it).
3. **Phase 3 → Phase 4**: T004 (doorbell wiring) should land before T008 (which spies on the wiring). T005/T006/T007 depend only on Phase 2 (they exercise the tailer directly, not the doorbell wiring) and can start once T003 is landed.
4. **Phase 4 → Phase 5**: Tests should be green before landing the changeset (T009) and running the final verification (T010).

**Parallel opportunities**:

- T001 and T002 can be authored in parallel; T002 imports from T001 so land in order.
- T005, T006, T007 have no shared files (three distinct test files) and can be authored in parallel once T003 is stable — all three marked `[P]`.
- T008 is not `[P]` — it edits a file (`__tests__/doorbell.test.ts`) that T004's wiring changes may also touch.

**Critical path**: T001 → T003 → T004 → T008 → T009 → T010. T002, T005, T006, T007 fan off.

## Notes on the mandatory-verification playbook-coupling rule

The `/tasks` skill instructs a permissive match against `packages/claude-plugin-cockpit/commands/*.md`. `plan.md:154` mentions `packages/claude-plugin-cockpit/commands/auto.md` — but explicitly as **out of scope**: that file lives in the sibling `agency` repository, not this one. Verified: `packages/claude-plugin-cockpit/tests/playbook-verification.test.ts` does not exist in `generacy-ai/generacy`. There are no local pin sites to re-pin because there is no local playbook edit. If the P4 dispatch step is picked up in a follow-up child issue of the Cockpit Remote Gates epic in the `agency` repo, that issue's `/tasks` run will emit the re-pin task against that repo's test file.
