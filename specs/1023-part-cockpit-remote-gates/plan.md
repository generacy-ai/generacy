# Implementation Plan: Cockpit doorbell — tail answers file → gate-answer events

**Feature**: Doorbell tails the operator-answer NDJSON file (`/workspaces/.generacy/cockpit/answers.ndjson`) alongside its smee subscription, filters by the bound `epicRef`, and emits validated `{type:"gate-answer", …}` events onto both the stdout NDJSON stream (harness `Monitor` wake path) and the per-epic in-process event bus (`cockpit_await_events` wake path).
**Branch**: `1023-part-cockpit-remote-gates`
**Status**: Complete
**Spec**: [`spec.md`](./spec.md)
**Clarifications**: [`clarifications.md`](./clarifications.md)
**Epic wire contracts**: [`cockpit-remote-gates-plan.md`](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md) (source of truth for the answer NDJSON line, gate record, outcome ack, and `gateId`/generation rules — implement as written; propose contract changes on the epic before diverging).

## Summary

Today the doorbell (`packages/generacy/src/cli/commands/cockpit/doorbell.ts`) has exactly one non-poll wake source: `SmeeDoorbellSource`. Operator gate answers for `/cockpit:auto` have no local wake path — a running session would block on `Monitor`/`cockpit_await_events` forever.

This feature adds a second wake source, an **answers-file tailer**, that:

1. **Waits for parent dir + file** (Q2 → B) — polls or `fs.watch`es the grandparent when `/workspaces/.generacy/cockpit/` is absent. Never `mkdir`s (single-writer ownership belongs to the orchestrator route, sibling issue).
2. **Replays existing content on start** (spec §Scope), capped at the **last ~10,000 lines** (Q5 → C — aligns with the event-bus `retentionCount=10000`; anything below the cap has nowhere to land in the bus). Emits a `warn` naming the skipped range when truncated.
3. **Tails new appends** through rotation / truncation via inode + size tracking.
4. **Filters by the bound `epicRef`** (Q1 → C) — the doorbell process is bound to a single epic; cross-epic lines are dropped and logged at `info` with the `gateId` so operators see cross-epic traffic without silencing the stream.
5. **Validates each line against the `GateAnswer` Zod schema** — malformed lines are skipped and reported via the injected `logger.warn` callback (Q4 → A: same seam as `SmeeDoorbellSource` / `source-selector`). The stream continues; stdout stays event-only.
6. **Emits** `{type:"gate-answer", …}` as (a) one NDJSON line on stdout via the shared `lineForEvent` writer and (b) one `bus.emit(...)` call on the same `EpicEventBus` the smee source and poll cycle use.
7. **Interleaves freely with smee** during startup replay (Q3 → A) — no drain barrier. The bus's monotonic per-emit cursor is the only ordering guarantee callers get; gate-answers and issue-transitions are semantically independent.

**Design invariants**:

- **Single-writer**: the orchestrator route (sibling P1 issue) is the sole writer; the tailer is read-only and never `mkdir`s.
- **Bound to one epic per process**: the tailer gets the same `epicRef` string the doorbell was invoked with; scope filtering happens *at the source* before any bus emit.
- **Stdout stays event-only**: warnings, info logs, and status transitions all go to `logger`/stderr. Adding a `doorbell-warning` variant to `CockpitStreamEvent` was explicitly rejected (Q4 option C).
- **`gate-answer` is a new `CockpitStreamEvent` variant** — extends the discriminated union in `packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts`. All existing consumers (`subscribeAndEmit`, `EpicEventBus.emit`, `cockpit_await_events`) work by construction because they operate on the union.
- **No orchestrator changes** in this branch. This feature owns only the doorbell reader path.

## Technical Context

**Language/Version**: TypeScript, Node.js ≥22 (matches `packages/generacy/package.json`).
**Primary Dependencies**: `zod` (line validation), `node:fs` + `node:fs/promises` (tail + dir/file wait), existing `@generacy-ai/cockpit` (logger seam only).
**Storage**: Reads a single file at `/workspaces/.generacy/cockpit/answers.ndjson`. No writes. No new persistence.
**Testing**: `vitest` (matches sibling doorbell suites — `doorbell/__tests__/smee-source-reconnect.test.ts`, `doorbell/__tests__/startup-retry.test.ts`, `__tests__/doorbell.subscribe.test.ts`).
**Target Platform**: In-cluster doorbell process (Linux, Node ≥22, same container as the orchestrator).
**Project Type**: Single-package extension (`packages/generacy`, cockpit command tree). No changes to `packages/cockpit` / `packages/orchestrator`.
**Performance Goals**: One tailer per doorbell process (one process per epic per `/cockpit:auto` invocation). Answer volume is human-paced (< 1 line / gate). Startup replay bounded by the 10 000-line ceiling.
**Constraints**:

- Must not `mkdir` the parent directory (Q2).
- Must not stall smee-source emissions behind the startup replay (Q3).
- Must not write warnings to stdout (Q4).
- Must not cache more than the last 10 000 lines on startup replay (Q5).
- Must not emit cross-epic lines to the bus (Q1) — poisoning the per-epic bus would mis-deliver another epic's answers via `wrong-epic` cursor confusion.

**Scale/Scope**: One new source module (`doorbell/answers-file-source.ts`), one new event variant (`watch/gate-answer.ts`), one new `Zod` schema, wiring in `doorbell.ts`, plus unit + integration tests. Estimated ~400–600 LOC production + ~600 LOC tests.

## Constitution Check

*No `.specify/memory/constitution.md` exists in this repo (verified — `find /workspaces/generacy -maxdepth 4 -name constitution.md` returns empty). Standard project conventions from `CLAUDE.md` apply:*

- ✅ **Changesets** (CLAUDE.md gate — CI-enforced): the implementation PR MUST add `.changeset/1023-cockpit-doorbell-answers-tailer.md` bumping `@generacy-ai/generacy` **minor** (new capability — `gate-answer` is a new event variant surfaced by the shared `CockpitStreamEvent` union that other packages parse). No other package's `src/` touched.
- ✅ **Cockpit label / marker vocabulary**: unaffected. The tailer reads a file; it does not touch GitHub labels or comment markers.
- ✅ **Wire-contract discipline** (spec §Summary): the answer NDJSON line shape MUST match `cockpit-remote-gates-plan.md` §Answer NDJSON line as written. Any divergence goes to the epic first. See `contracts/gate-answer-line.md`.
- ✅ **Never-merge-on-red** (auto.md invariant): unaffected — this feature adds a read path only; no mutation.
- ✅ **Observer independence** (established by #1015 SC-005): unaffected. Observers (`cockpit_status`, `cockpit_context`, `cockpit_await_events`) already read from the bus without side effects; they simply see a new event variant.
- ✅ **Single-writer discipline** for the answers file: enforced by construction — the tailer holds no write permissions to the file or its parent dir.

## Deferred Clarifications — Plan-Phase Decisions

Two implementer-level choices sit between the spec clarifications and the tasks phase. Both are recorded here so `/speckit:tasks` can lock them in.

### D-1: Tail mechanism (`fs.watch` vs. poll vs. hybrid)

**Choice**: **Hybrid** — `fs.watch` on the parent dir for change notifications, plus a bounded **fallback poll every 2 s** as a safety net.

**Rationale**:

- `fs.watch` is unreliable across bind mounts, tmpfs, and some Linux inode-swap paths — pathologies that show up in cluster-base's overlay/tmpfs layout. A pure-`fs.watch` implementation can miss rotation/truncation silently.
- A pure-poll implementation has worst-case latency = poll interval; 2 s is acceptable for human-paced gate answers but wastes CPU on a fully-idle cluster.
- The hybrid uses `fs.watch` for the low-latency-good-case path and poll as the "did we miss anything" safety net (same pattern as `SmeeDoorbellSource`'s `safetyNetIntervalMs`).
- Concretely: after each `fs.watch` event AND on each poll tick, the tailer does one `stat()` and compares `(ino, size)` to the last-observed pair. Growth → read from last offset to new size. Inode change → rotation → reopen at 0 and re-emit from 0 (subject to the 10 000-line cap, if the new file is already large — pathological but bounded).

**Alternatives considered**:

- **Pure `fs.watch`** (rejected): can miss events on bind mounts / tmpfs / cross-container writes.
- **Pure poll (`chokidar`-style)** (rejected): worst-case 2 s latency is fine, but wastes wake-ups on the idle path.
- **`tail -F` subprocess** (rejected): adds a subprocess dependency and requires parsing rotation/truncation semantics from `tail`'s stderr.

**Public surface**: `AnswersFileSourceOptions` accepts `pollIntervalMs?: number` (default 2 000) and `useFsWatch?: boolean` (default `true`, disabled in tests that want deterministic timing).

### D-2: Replay-cap enforcement location

**Choice**: **In the tailer** — the tailer counts lines during startup replay and truncates the head to the last 10 000. The cap does NOT live in the bus (which already trims to `retentionCount`, but only after emit).

**Rationale**:

- Emitting 10 000+ lines just to have the bus trim them wastes CPU + stdout bandwidth (each emit also fires an FR-005 stdout line).
- The cap serves two goals: bound startup latency AND emit a single `warn` naming the skipped range so operators see truncation. A bus-side cap makes the warn structurally impossible.
- Bounded memory during count-up: the tailer streams the file line-by-line (never `readFile`), counts to N, then rewinds to the (N − 10 000)th newline offset via a **second forward pass** — trivially fits in memory for even a multi-GB file.
- Alternative "read backward" (rejected): would eliminate the second pass but complicates rotation-handling and adds a mid-line UTF-8 boundary risk.

**Public surface**: `AnswersFileSourceOptions.replayLineCap?: number` (default 10 000). Setting `Infinity` disables the cap (test-only; not exposed to CLI callers).

## Project Structure

### Documentation (this feature)

```text
specs/1023-part-cockpit-remote-gates/
├── plan.md                          # This file
├── spec.md                          # Feature spec (read-only)
├── clarifications.md                # Batch 1 clarifications (read-only)
├── research.md                      # Phase 0 output (new)
├── data-model.md                    # Phase 1 output (new)
├── contracts/
│   ├── answers-file-source.md       # Tailer interface + lifecycle (new)
│   ├── gate-answer-event.md         # `CockpitStreamEvent` variant contract (new)
│   └── gate-answer-line.md          # Wire NDJSON line contract (defers to epic-plan doc) (new)
├── quickstart.md                    # Operator + implementer usage (new)
└── checklists/                      # Empty (no checklist requested)
```

### Source Code (repository root)

**New files** (all under `packages/generacy/src/cli/commands/cockpit/`):

```text
packages/generacy/src/cli/commands/cockpit/
├── doorbell/
│   ├── answers-file-source.ts             # NEW — the tailer: waits for parent dir + file, streams startup replay (capped at 10 000 lines), tails new appends via fs.watch + 2 s fallback poll, handles rotation/truncation via inode + size, filters by epicRef, validates each line, emits {type:"gate-answer"} to bus + stdout via injected sink
│   └── __tests__/
│       ├── answers-file-source.unit.test.ts       # NEW — line parsing, epicRef filter, malformed-line skip + warn, replay-cap truncation + warn
│       ├── answers-file-source.tail.test.ts       # NEW — fs.watch + poll integration, rotation, truncation, dir-then-file appearance
│       └── answers-file-source.replay.test.ts     # NEW — startup replay ordering, cap enforcement, cross-source interleave with smee
├── watch/
│   ├── gate-answer.ts                     # NEW — GateAnswerEventSchema (Zod discriminated-union member with type:"gate-answer") + GateAnswerLineSchema (wire schema for the NDJSON line) + mapping helper
│   └── stream-event.ts                    # MODIFIED — extend CockpitStreamEventSchema union with GateAnswerEventSchema
└── doorbell.ts                            # MODIFIED — instantiate AnswersFileSource alongside SmeeDoorbellSource / poll-fallback; wire its onEvent to the same stdout writer + bus emit path (via a new AnswersFileSource-aware branch parallel to runSmeeMode / runPollMode)
```

**Modified — tests that need extension** (existing files):

```text
packages/generacy/src/cli/commands/cockpit/__tests__/doorbell.test.ts
  # ADD: cases covering the tailer's presence in each doorbell mode (form-1 with smee, form-1 with poll, form-2 tracking) — assert tailer is started with the correct epicRef and stopped cleanly on SIGINT.
```

**Changeset**:

```text
.changeset/
└── 1023-cockpit-doorbell-answers-tailer.md    # NEW — minor bump: @generacy-ai/generacy
```

**Not touched** (verified out-of-scope):

- `packages/cockpit/` — no gh wrapper changes; the tailer reads a file, not GitHub.
- `packages/orchestrator/` — the sibling P1 issue owns the write path to `answers.ndjson`.
- `packages/generacy/src/cli/commands/cockpit/mcp/` — bus + registry work as-is because `bus.emit` takes the full `CockpitStreamEvent` union.
- Skill-side prose (`agency` repo `packages/claude-plugin-cockpit/commands/auto.md`) — the P4 dispatch step that consumes `gate-answer` events is a separate epic child issue.

**Structure Decision**: Sit alongside existing doorbell sources (`smee-source.ts`, `source-selector.ts`, `startup-retry.ts`). The tailer is a peer of the smee source in scope, lifecycle, and injection pattern — same `onEvent` callback shape, same `logger` seam, same `stop()` semantics. `doorbell.ts` wires all three (poll-bus subscriber, smee source, answers tailer) side-by-side.

## Constitution Re-Check (Post-Design)

- ✅ No new packages, no new dependencies (`zod` is already a dev + runtime dep of `@generacy-ai/generacy`).
- ✅ `gate-answer` event variant shares the discriminator field (`type`) with sibling variants (`issue-transition`, `phase-complete`, `epic-complete`), so Zod's `discriminatedUnion` extends without ambiguity.
- ✅ Stdout emission uses the existing `lineForEvent` writer (`doorbell/subscribe.ts:22`) — no new serialisation path, no new NDJSON line shape at the transport layer.
- ✅ Bus emission uses `EpicEventBus.emit(event)` (`mcp/event-bus.ts:144`) unchanged — the tailer just adds another producer alongside the poll cycle and smee source.
- ✅ `cockpit_await_events` unchanged — new variant flows through the existing `WaitForResult.entries` shape.
- ✅ Cross-package impact: zero. Only `@generacy-ai/generacy` `src/` is touched.
- ✅ FR-006 `source=…` stderr line unchanged — the answers tailer runs concurrently under whatever source the selector reports; it is a *second* source, not a third selectable state.
- ✅ SC-003-style "in file order" assertion (spec §Acceptance) is achievable because the tailer emits synchronously per line inside its own loop; the bus assigns cursor positions atomically per `emit()`.

## Complexity Tracking

No constitution violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| (none)    | —          | —                                    |

## Next Step

Run `/speckit:tasks` to generate the ordered task list.
