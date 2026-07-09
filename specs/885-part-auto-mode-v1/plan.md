# Implementation Plan: Auto mode phase-complete / epic-complete synthetic events

**Feature**: `cockpit watch` derives `phase-complete` and `epic-complete` synthetic NDJSON events from the snapshot diff, plus `--exit-on-epic-complete` termination flag
**Branch**: `885-part-auto-mode-v1`
**Date**: 2026-07-09
**Status**: Complete
**Spec**: [spec.md](./spec.md)

## Summary

Extend `cockpit watch` with two engine-owned aggregate events that give auto-mode its phase-queue gates and its terminal edge:

- **`phase-complete`** fires once per *transition into* a fully-closed phase (last open issue in a phase transitions to CLOSED; `not_planned` counts as done per #873 state-dominates-labels). Reopens that regress and re-complete fire again.
- **`epic-complete`** fires once when every ref in the epic is closed, regardless of phase structure. With `--exit-on-epic-complete`, watch flushes it and exits 0 — the machine-parseable termination signal auto-mode needs.

Ordering within a poll cycle is: (1) per-issue events in existing order → (2) `phase-complete` events in `parsed.phases` body order → (3) `epic-complete` strictly last. `--exit-on-epic-complete` exits only after the `epic-complete` line is flushed. This guarantees cause precedes effect and the termination edge is the final line ever written.

Aggregation edges are pinned by clarifications:
- Startup sweep: pre-completed phases emit `phase-complete` with `initial: true`; a pre-completed epic emits `epic-complete` with `initial: true`.
- Empty phase (heading with `refs.length === 0`): counts as trivially complete for `epic-complete`, **never** emits `phase-complete`, emits one stderr warn at startup.
- `(no phase)` bucket: excluded from `phase-complete`, included in `epic-complete`.
- Phase-less epic (`parsed.phases.length === 0`): emits `epic-complete` when every ref closes; no `phase-complete` fires.

Payload shape (Q1 → B): `type`, `phase` (phase-complete only), `initial?`, `ts`, `epicRepo`, `epicNumber`. **No** `closedRefs`, `totalCount`, or `suggestion` fields — the engine's contract is machine-pure NDJSON; suggestion prose is the plugin's job (agency#386).

## Technical Context

**Language/Version**: TypeScript, Node >=22 (per generacy CLI package)
**Primary Dependencies**: `zod` (payload validation, existing pattern in `emit.ts`); `@generacy-ai/cockpit` (`resolveEpic`, `ParsedPhase`, `IssueRef`)
**Storage**: In-process only — aggregate state (`Set<phaseKey>` of phases previously seen complete, boolean for epic) lives alongside `SnapshotMap` in `watch.ts`'s poll shell.
**Testing**: `vitest` — unit tests colocated at `packages/generacy/src/cli/commands/cockpit/__tests__/watch.*.test.ts` (existing convention).
**Target Platform**: CLI (`generacy cockpit watch`), consumed by auto-mode NDJSON stdin readers.
**Project Type**: Single package extension (no new package boundary).
**Performance Goals**: Aggregate computation is O(refs) per poll — negligible vs. GitHub API round-trips that dominate poll wall-clock.
**Constraints**: 
  - Stdout stays machine-pure NDJSON (Q2 → A). Human-readable prose (`epic complete 🎉`, `suggested: /cockpit:queue …`) is out of scope for this feature — presentation belongs to the watch plugin.
  - Termination edge (`--exit-on-epic-complete`) must not depend on epic body formatting (Q5 → A) — a phase-less epic must still exit on its own last close.
  - Ordering guarantee (Q4 → A) is load-bearing for consumer correctness; must be preserved end-to-end in the poll shell, not the pure `runOnePoll`.
**Scale/Scope**: One epic per watch process; ref count bounded by epic body size (typically <100 refs).

## Constitution Check

No `.specify/memory/constitution.md` file exists. Repo conventions applied instead:

| Gate | Status | Notes |
|------|--------|-------|
| Engine/plugin separation | ✅ | Engine emits payloads; plugin derives suggestion prose (agency#386 self-contained-commands principle). Q2 → A explicitly enforces this. |
| Dev-time validation via zod | ✅ | New `AggregateEventSchema` follows existing `CockpitEventSchema` pattern. |
| Idempotence at edges | ✅ | Startup sweep + `initial: true` marker matches the existing per-issue `computeInitialSweep` pattern in `diff.ts`. |
| No stateful mutation in pure diff | ✅ | Aggregate state (previously-seen-complete phase set) lives in the poll shell (`watch.ts`), not in `runOnePoll`. `computeAggregateEvents` is pure over its inputs. |
| Structured errors, no console.log | ✅ | Reuses `emit()` for stdout NDJSON; stderr writes via `process.stderr.write` per existing convention. |

## Project Structure

### Documentation (this feature)

```text
specs/885-part-auto-mode-v1/
├── spec.md              # Feature spec (read-only)
├── clarifications.md    # Q1–Q5 answered
├── plan.md              # This file
├── research.md          # Design rationale
├── data-model.md        # Aggregate event schema + state types
├── quickstart.md        # Consumer/test invocation guide
├── contracts/
│   └── aggregate-events.md   # Payload contract
└── tasks.md             # (Generated by /speckit:tasks — not by this command)
```

### Source Code (changes)

```text
packages/generacy/src/cli/commands/cockpit/
├── watch.ts                          # MODIFIED: aggregate state, --exit-on-epic-complete flag, ordering shim, startup sweep+warn
└── watch/
    ├── aggregate.ts                  # NEW: computeAggregateEvents(prev, curr, parsed, aggState) — pure
    ├── aggregate-emit.ts             # NEW: AggregateEventSchema + emitAggregate() (kept separate from emit.ts to avoid widening CockpitEventSchema union)
    ├── diff.ts                       # UNCHANGED (per-issue events)
    ├── emit.ts                       # UNCHANGED (per-issue emit)
    ├── poll-loop.ts                  # UNCHANGED — runOnePoll stays pure over per-issue events
    └── snapshot.ts                   # UNCHANGED

packages/generacy/src/cli/commands/cockpit/__tests__/
├── watch.aggregate.test.ts           # NEW: unit tests over computeAggregateEvents (all 8 spec-listed test cases)
├── watch.aggregate-emit.test.ts      # NEW: schema validation
└── watch-subprocess.integration.test.ts   # EXTENDED: --exit-on-epic-complete end-to-end

packages/generacy/README.md            # EXTENDED: contract section for phase-complete / epic-complete + --exit-on-epic-complete
```

**Structure Decision**: Additive changes only. No refactor of `runOnePoll`, `computeTransitions`, or `emit()` — the aggregate layer sits *above* per-issue transitions in the poll shell, consuming the same `curr: SnapshotMap` and `parsed: ParsedEpicBody` that already flow through `watch.ts`. Kept in `packages/generacy/src/cli/commands/cockpit/watch/` (not promoted to `@generacy-ai/cockpit`) because the aggregate types depend on `SnapshotMap` and `ChecksRollup`, which live in the CLI package.

## Complexity Tracking

No constitution violations. One deliberate structural choice worth calling out:

| Decision | Rationale | Rejected Alternative |
|----------|-----------|---------------------|
| Separate `aggregate-emit.ts` (new schema) instead of extending `CockpitEventSchema` union | Aggregate events carry `epicRepo`/`epicNumber` and drop `repo`/`kind`/`number`/`url`/`labels`/`sourceLabel`/`from`/`to`. A discriminated-union widening would force every existing consumer to narrow before reading `repo` — a breaking wire-shape change for a purely additive feature. | Widening `CockpitEventSchema` to a discriminated union on `event`. Rejected because it silently reshapes every existing per-issue field access on the consumer side. |
| Aggregate state (`Set<phaseKey>`, `boolean`) lives in `watch.ts`, not `runOnePoll` | Preserves `runOnePoll` as pure over `(prev, curr)`. Aggregate state persists across polls but is not per-poll input; it belongs to the loop shell. | Threading aggregate state into `PollDeps`. Rejected because it couples pure poll semantics to shell-owned lifecycle. |
| `--exit-on-epic-complete` gates exit *after* stdout flush, not before | Q4 → A requires the `epic-complete` line to be the final line ever written. A pre-flush exit races against Node's stdout buffer under pipe consumers. | Setting a flag and letting the loop-tail check exit on next tick. Rejected because it opens a window for interleaved stderr diagnostics. |

## Key Technical Decisions

1. **Payload shape locked to Q1 → B**: `{ type, phase?, initial?, ts, epicRepo, epicNumber }`. No `closedRefs`, no `totalCount`, no `suggestion`. Any future field is an additive migration.
2. **Aggregate computation is pure**: `computeAggregateEvents(currMap, parsed, prevAggState, now)` returns `{ events, nextAggState }`. The poll shell owns state transitions.
3. **Empty-phase handling (Q3 → B)**: Phase with `refs.length === 0` is trivially complete for `epic-complete` but never emits `phase-complete`. One stderr warn at startup per empty phase: `phase "<heading>" has no issue refs; treated as complete`.
4. **Phase-less epic (Q5 → A)**: `parsed.phases.length === 0` → `epic-complete` fires when every ref closes; `phase-complete` never fires; `--exit-on-epic-complete` still works.
5. **Ordering (Q4 → A)** is implemented in `watch.ts`'s emit sequence: iterate `result.events` first (per-issue), then iterate `aggregateResult.events` (which are already sorted phase-first-by-body-order, epic-last-if-firing).
6. **State-dominates-labels (#873)**: "Phase complete" checks `state === 'CLOSED'` (regardless of `stateReason`). A `not_planned` closure counts as done for aggregation — matches the spec's explicit callout.
7. **`--exit-on-epic-complete` flush guarantee**: After emitting the `epic-complete` line, `await new Promise(r => process.stdout.write('', r))` (or equivalent drain) before `process.exit(0)`. Prevents truncation under pipe consumers.

## Suggested Next Step

Run `/speckit:tasks` to generate the ordered task list from this plan and `spec.md`'s Tests section.
