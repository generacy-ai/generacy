# Tasks: Journal-based stuck detection (G5.2)

**Input**: Design documents from `/specs/793-epic-generacy-ai-tetrad/`
**Prerequisites**: plan.md (required), spec.md (required), data-model.md, contracts/journal.md, research.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
  - **US1**: `cockpit status` surfaces a stuck marker for stale `agent:in-progress` issues
  - **US2**: `cockpit watch` emits `stuck` / `recovered` NDJSON events
- **Foundational** tasks (no [Story] tag) unblock both stories.

## Phase 1: Foundational — types & config

These block both US1 and US2.

- [X] T001 Add `StuckReason` union and `JournalLivenessResult`, `ReadJournalLivenessOptions` interfaces to `packages/cockpit/src/types.ts` (export from this module so consumers don't reach into `journal.js`).
- [X] T002 [P] Extend `CockpitConfigSchema` in `packages/cockpit/src/config/schema.ts` with `stuckThresholdMinutes: z.number().int().positive().default(15)`.
- [X] T003 Update `packages/cockpit/src/config/loader.ts` to pass `stuckThresholdMinutes` through into the loaded config object (no env-var override per Q5=A). Depends on T002.

## Phase 2: Core sensor — `journal.ts`

The pure liveness reader. Depends on Phase 1 types.

- [X] T010 Create `packages/cockpit/src/journal.ts` implementing `readJournalLiveness(options)` per `contracts/journal.md` §`readJournalLiveness`:
  - Path: `{cwd ?? process.cwd()}/specs/{issueNumber}/conversation-log.jsonl`.
  - `fs.stat` ENOENT → `{stuck:false, stuckReason:null, lastEntryAt:null}` (Q1=A).
  - I/O error / empty file / unparsable last-32-lines / missing-or-invalid `timestamp` → `{stuck:false, stuckReason:'no-journal', lastEntryAt:null}` and one `logger.warn(...)` to stderr (Q4=A).
  - Walk backward up to 32 lines from end to find the most recent parsable entry.
  - `stuck = (now - timestamp) > thresholdMinutes*60_000`; negative age → `stuck:false`.
  - Never throws; at most one stat + one read; no background timers.
- [X] T011 Add `readJournalLiveness` and its types to `packages/cockpit/src/index.ts` public exports.
- [X] T012 [P] Add unit tests `packages/cockpit/src/__tests__/journal.test.ts` covering every row of the behavior matrix in `contracts/journal.md` (missing file, EACCES, empty file, unparsable trailing 32 lines, missing/invalid timestamp, fresh entry, threshold-boundary entry, stale entry, future timestamp). Inject `cwd`, `now`, `logger` for hermetic tests.
- [X] T013 [P] Extend `packages/cockpit/src/__tests__/config-loader.test.ts` to assert `stuckThresholdMinutes` defaults to 15 and that an explicit `cockpit.stuckThresholdMinutes` in YAML is honored (and that Zod rejects 0, negatives, floats, strings).

## Phase 3: Status wiring (US1)

Surfaces stuck/stuckReason in `cockpit status` table and `--json` envelope. Depends on Phase 2.

- [X] T020 [US1] Extend `StatusRow` in `packages/generacy/src/cli/commands/cockpit/status/row.ts` with `stuck: boolean` and `stuckReason: StuckReason`. Non-gated rows default to `{stuck:false, stuckReason:null}`.
- [X] T021 [US1] In `packages/generacy/src/cli/commands/cockpit/status.ts`, read `loaded.config.stuckThresholdMinutes`. After classification, **only** when `classified.state === 'active' && classified.sourceLabel === 'agent:in-progress'`, call `readJournalLiveness(...)` and thread `{stuck, stuckReason}` into `buildStatusRow(...)`. All other paths (including PRs) skip the sensor.
- [X] T022 [US1] Update `packages/generacy/src/cli/commands/cockpit/status/render-table.ts` to add a `STUCK` column between `STATE` and `SOURCE` per `contracts/journal.md` §`cockpit status` (empty string when not stuck, `STALE` when stuck). `--json` envelope passes the new fields through additively.
- [X] T023 [US1] [P] Extend `packages/generacy/src/cli/commands/cockpit/status/color.ts` (or the existing `chalkColorizer` site) so the `STUCK` cell renders red on TTY when `row.stuck === true`.

## Phase 4: Watch wiring (US2)

Emits `stuck` / `recovered` NDJSON events from `cockpit watch`. Depends on Phase 2; independent of Phase 3.

- [X] T030 [US2] Extend `IssueSnapshot` in `packages/generacy/src/cli/commands/cockpit/watch/snapshot.ts` with `stuck: boolean` and `stuckReason: StuckReason`. `PrSnapshot` unchanged.
- [X] T031 [US2] In `packages/generacy/src/cli/commands/cockpit/watch.ts`, read `loaded.config.stuckThresholdMinutes` and thread it into `runOnePoll` via `PollDeps.stuckThresholdMinutes`.
- [X] T032 [US2] In `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts`, after `classifyIssue`, when the same gate (`active` + `agent:in-progress`) matches, call `readJournalLiveness` and attach the result to the snapshot. All other paths set `stuck:false, stuckReason:null`.
- [X] T033 [US2] In `packages/generacy/src/cli/commands/cockpit/watch/diff.ts`:
  - Add `'stuck' | 'recovered'` to `CockpitEventDiscriminator`.
  - Add optional `stuckReason?: StuckReason` to `CockpitEvent` (set only on `stuck` events).
  - In `diffIssue`, emit `stuck` when `prev.stuck === false && curr.stuck === true` (with `stuckReason: curr.stuckReason`).
  - Emit `recovered` when `prev.stuck === true && curr.stuck === false` **and** the issue still classifies as `active` via `agent:in-progress`. If the issue left `agent:in-progress`, emit nothing (the existing `label-change` event covers it — Q2=A dedupe).
  - Event ordering: `label-change → lifecycle → pr-checks → stuck/recovered`.
- [X] T034 [US2] [P] Extend `packages/generacy/src/cli/commands/cockpit/__tests__/watch/diff.test.ts` with cases for: stuck-transition emission, recovered-transition emission, label-change-vs-recovered dedupe, no-op when both prev and curr are `stuck:true` (no re-emit), and the `stuck/recovered` event-ordering rule.

## Phase 5: Polish

- [X] T040 [P] Update `specs/793-epic-generacy-ai-tetrad/quickstart.md` if any contract detail drifted during implementation (operator-tunable threshold, expected TTY output, NDJSON event shape).
- [X] T041 [P] Run the full cockpit test suite (`pnpm --filter @generacy-ai/cockpit test` and the generacy CLI cockpit tests) to confirm no regressions in classifier, manifest, or existing diff cases.

## Dependencies & Execution Order

```
Phase 1 (T001 → T002 → T003)
        │
        ▼
Phase 2 (T010 → T011) ── T012 [P] ── T013 [P]
        │
        ├─────────────────────┐
        ▼                     ▼
Phase 3 (US1)         Phase 4 (US2)
T020 → T021 → T022    T030 → T031 → T032 → T033
       │                                    │
       T023 [P]                             T034 [P]
        │                                    │
        └──────────────┬─────────────────────┘
                       ▼
                Phase 5 (T040 [P], T041 [P])
```

**Sequential within file**: T001 → T002 → T003 (config-loader depends on schema). T010 → T011 (export depends on module). Inside each story, the type extension precedes the call-site that fills it, which precedes the renderer/diff that reads it.

**Parallel opportunities**:
- T012 and T013 run alongside T010/T011 (separate test files).
- After Phase 2 lands, US1 (T020–T023) and US2 (T030–T034) are fully independent — different files, no shared call sites.
- T023 and T034 are isolated within their stories (color file, test file) — `[P]` against the rest.
- Phase 5 tasks are both `[P]` (docs + test-suite run).

**No TDD ordering enforced** — vitest cases (T012, T013, T034) are co-located with their implementation and may land in the same PR. The plan does not request strict red-green-refactor.

---

**Next step**: Run `/speckit:implement` to begin execution.
