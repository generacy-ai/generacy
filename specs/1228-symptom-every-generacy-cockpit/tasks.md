# Tasks: Scope cockpit doorbell gate-answer replay by epic ref set and persist consumed position

**Input**: Design documents from `/specs/1228-symptom-every-generacy-cockpit/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4; FND = shared foundation)

All paths are under `packages/generacy/src/cli/commands/cockpit/` unless stated otherwise.

## Phase 1: Foundation

- [X] T001 [FND] Extend `FsFacade` in `doorbell/answers-file-source.ts` with the optional
      write surface the cursor store needs: `mkdir(path, { recursive })`, `readFile(path)`,
      `writeFile(path, data)`, `rename(from, to)`. Keep them **optional** members so existing
      read-only fakes in `__tests__/` stay valid. Wire the real `node:fs/promises`-backed
      implementation in the production default `fs` object used by `doorbell.ts`
      (`data-model.md` § Extended options).

## Phase 2: New modules (parallelizable — distinct new files)

- [X] T002 [P] [US2] Implement `EpicRefSetHolder` in new file `doorbell/ref-set-holder.ts`
      per `contracts/epic-ref-set-holder.md`:
        - Constructor opts `{ epicRef, gh, logger, resolve?=resolveEpic, missRefreshMinIntervalMs=30_000, now? }`.
        - `get current(): RefSetView | null` / `get resolved(): ResolvedEpic | null`
          (null until first successful resolve; never degrades to null after first success).
        - `refresh()`: unthrottled resolve+store via `buildRefSet(resolveEpic(...))`; throws
          on failure ONLY when there is no prior successful set; after first success, warn +
          retain previous set. Resets the throttle window.
        - `refreshOnMiss()`: throttled (≤1 resolve per `missRefreshMinIntervalMs`), never
          throws, single-flight coalescing of overlapping calls.
      Import `resolveEpic`/`buildRefSet`/`RefSetView`/`ResolvedEpic` from the same sources
      `smee-source.ts` uses (`@generacy-ai/cockpit`, `doorbell/webhook-to-event.ts`).

- [X] T003 [P] [US1] Implement `AnswersCursorStore` in new file
      `doorbell/answers-cursor-store.ts` per `contracts/answers-cursor-store.md` and
      `data-model.md` § AnswersCursor:
        - `AnswersCursorSchema` (zod): `{ version: z.literal(1), ino, offset, updatedAt }`.
        - Constructor opts `{ answersFilePath, epicRef, logger, fs?, flushDebounceMs=500, now? }`;
          cursor path `<dirname(answersFilePath)>/cursors/<owner>__<repo>__<n>.json`
          (owner/repo lowercased).
        - `load(): Promise<{ ino, offset } | null>` — missing/unreadable/invalid/wrong-version
          ⇒ null, never throws.
        - `advance(ino, offset): void` — in-memory update + debounced persist; monotonic
          within an ino (never persist a smaller offset for the same ino); a new ino resets.
        - `flush(): Promise<void>` — atomic tmp+rename; lazy `mkdir -p cursors/` at first
          flush; failures warn, never throw.

## Phase 3: Core integration

- [X] T004 [US2] In `doorbell/smee-source.ts`, delegate ref-set ownership to
      `EpicRefSetHolder`: replace the private `refSet`/`currentResolved` fields with reads of
      `holder.current`/`holder.resolved`; accept the holder as a constructor/option input;
      the startup blocking resolve calls `holder.refresh()` and still propagates failure
      (poll-fallback demotion unchanged); debounced-webhook and safety-net timers call
      `holder.refresh()`. Keep all debounce/timer logic in the smee source — only the
      resolve/store moves. `onRefSetRefreshFailure` semantics unchanged.

- [X] T005 [US2] [US3] In `doorbell/answers-file-source.ts`, replace `processLine()` step (c)
      owner/repo compare with the ref-set membership test (`data-model.md` § Per-line
      pipeline step c″): parse issue-ref via `parseIssueRefFromGateKey`; non-issue target
      bypasses scoping and emits; membership key `owner/repo#number` lowercased against
      `holder.current.issues`; on a miss `await holder.refreshOnMiss()` then re-check, drop +
      `info` log with `gateId` (+ scope, boundEpic) if still foreign. Delete the
      `KNOWN LIMITATION` comment on `epicRef`. When constructed **without** a holder (harness
      mode), retain the legacy case-insensitive owner/repo compare. Add
      `refSetHolder?`/`replayWindowMs?`/`cursorStore?` (+ `cursorDir?` test seam) to
      `AnswersFileSourceOptions`.

- [X] T006 [US4] In `doorbell/answers-file-source.ts`, add the recency-window pre-filter
      (step c′) to the **replay branches only** (fresh/stale cursor, rotation, truncation):
      drop lines whose `answeredAt < now - replayWindowMs` (default 86_400_000) with an
      `info` "window drop" log, evaluated **before** the ref-set test so out-of-window lines
      never trigger a miss refresh. Never applied to resumed-cursor tailing. Keep
      `DEFAULT_REPLAY_LINE_CAP` as a backstop.

- [X] T007 [US1] In `doorbell/answers-file-source.ts`, make `lastKnownIno`/`lastKnownSize`
      cursor-backed via `AnswersCursorStore`. On first file discovery, apply the state table
      (`data-model.md` § validation/staleness): resume `[offset, size)` with no replay/window
      when `cursor.ino === stat.ino && cursor.offset <= stat.size`; otherwise fresh-cursor
      replay from byte 0 (window + scope). Preserve the existing rotation (ino change) /
      truncation (size shrink) branches, now window-bounded and rewriting the cursor for the
      new ino. Advance the cursor positionally to `lineEndByte` after **every** processed
      line (emitted after awaited `onEvent` resolves; window/foreign/malformed drops too);
      `flush()` at replay drain and in `stop()`.

- [X] T008 [US1] [US2] [US4] In `doorbell.ts` (`runDoorbell`), wire it together: construct one
      `EpicRefSetHolder` per run when `deps.gh` is present and pass it to both the tailer
      (`refSetHolder`) and `SmeeDoorbellSource`; construct the `AnswersCursorStore` (keyed by
      epic scope, cursor dir derived from the answers-file dirname) and pass it to the tailer;
      parse `COCKPIT_ANSWERS_REPLAY_WINDOW_MS` (positive integer; invalid ⇒ default 24h +
      `warn`) into `replayWindowMs`. Harness mode (`COCKPIT_DOORBELL_HARNESS=1`, no `gh`):
      construct no holder — tailer keeps legacy scoping.

## Phase 4: Tests (FR-008 — write after the modules they exercise exist)

- [X] T009 [P] [US2] New `doorbell/__tests__/ref-set-holder.test.ts`: first-resolve populates
      `current`; failed refresh after first success retains the previous set (never null);
      `refreshOnMiss()` throttle (≤1 resolve per 30s); single-flight coalescing; unknown ref
      still foreign after refresh → caller drops.

- [X] T010 [P] [US1] New `doorbell/__tests__/answers-cursor-store.test.ts`: load/advance/flush
      round-trip; atomic rename (no partial reads); corrupt/invalid/wrong-version file → null;
      monotonic-within-ino; new ino resets offset; lazy `cursors/` mkdir at first flush; write
      failure warns and does not throw.

- [X] T011 [US4] Extend `doorbell/__tests__/answers-file-source.replay.test.ts`: fresh-cursor
      byte-0 replay bounded by recency window AND ref-set scope; window drops logged `info`;
      replay-line-cap backstop still applies.

- [X] T012 [US1] Extend `doorbell/__tests__/answers-file-source.tail.test.ts`: resumed cursor
      emits only bytes past `offset` with no window; fully-consumed file → zero events on
      restart; rotation (ino change) and truncation (size shrink) → window-bounded replay with
      cursor rewritten for the new ino.

- [X] T013 [US2] [US3] Extend `doorbell/__tests__/answers-file-source.unit.test.ts`: same-repo
      foreign-epic answer dropped + `info` with `gateId`; cross-repo in-scope child emitted
      (#1111 regression); unknown ref → `refreshOnMiss()` → late-created child emitted after
      refresh; no-holder (harness) mode keeps legacy owner/repo compare; non-issue gateKey
      target still emits.

## Phase 5: Docs, contract, changeset, cleanup

- [X] T014 [P] [US1] [US2] Update the contract
      `specs/1023-part-cockpit-remote-gates/contracts/answers-file-source.md` (FR-007) to
      describe epic-ref-set scoping (replacing the owner/repo compare), the persisted
      consumed cursor, the recency window on replay branches, and the revised state table.
      Update the doorbell docs referenced there to match.

- [X] T015 [P] Add a **newly created** changeset file
      `.changeset/1228-doorbell-answer-replay-scope.md` — `patch` bump for
      `@generacy-ai/generacy` (defect fix; the only package with non-test `src/` changes).
      Required by the CLAUDE.md changeset CI gate.

- [ ] T016 Link and close generacy#1111 as subsumed by this work (cross-repo epic children
      now emitted — US3 / FR-003). Reference #1228 in the closing note.

## Dependencies & Execution Order

**Sequential backbone**:
- Phase 1 (T001 FsFacade) → gates T003 (cursor store writes) and T007 (cursor-backed tailer).
- Phase 2 (T002 holder, T003 cursor store) → gates Phase 3 integration.
- Phase 3 order: T004 (smee delegate) and T005 (scope test) both depend on T002; T006 and
  T007 modify the same file (`answers-file-source.ts`) as T005 — run T005 → T006 → T007
  **sequentially** (same file). T008 (doorbell wiring) depends on T002, T003, T005–T007.
- Phase 4 tests depend on the modules/behaviour they exercise (T009←T002, T010←T003,
  T011–T013←T005–T008).
- Phase 5 docs/changeset depend on the final behaviour (T014) but T015/T016 are independent.

**Parallel opportunities**:
- T002 ∥ T003 (distinct new files, only T003 needs T001).
- T009 ∥ T010 (distinct new test files); T011/T012/T013 touch three distinct existing test
  files and may run in parallel once Phase 3 lands.
- T014 ∥ T015 (docs vs changeset, different files).

**Same-file serialization** (never parallel):
- T005, T006, T007 all edit `answers-file-source.ts` — serialize.
- T011, T012, T013 edit three separate `__tests__/*.test.ts` files — parallel-safe.

**Next step**: `/speckit:implement` to begin execution.
