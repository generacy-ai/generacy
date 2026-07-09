# Research: Auto-mode synthetic aggregate events

## Context

`cockpit watch` already computes a per-poll `SnapshotMap` diff (`packages/generacy/src/cli/commands/cockpit/watch/`) and emits one NDJSON event per issue/PR state transition. Auto-mode (v1.5) needs two additional signals:

- A **phase gate** — "the last open issue in phase X just closed; queue phase X+1?"
- A **termination edge** — "the entire epic is done; auto-mode may exit."

Both are aggregate over the `SnapshotMap`, and both must be derivable from the same state watch already has. The spec asserts (per plugin-narrates/engine-decides): aggregation belongs in the engine.

## Decisions

### D1. Payload shape (locked by clarifications Q1 → B)

**Decision**: `{ type, phase?, initial?, ts, epicRepo, epicNumber }`. No `closedRefs`, `totalCount`, or `suggestion`.

**Rationale**: Consumers need correlation (epic ref) without threading CLI args through their own state. `closedRefs`/`totalCount` duplicate state derivable from `status --json` — every place they appear on the wire is a place they can drift stale (reopen races, no-phase refs). `suggestion` is presentation, not machine contract.

**Rejected**:
- Rich payload with `closedRefs`+`suggestion` — creates lying-payload risk on the exact edge cases the spec enumerates (reopens, empty phases, no-phase refs).
- Minimal without epic ref — forces consumers to thread `--epic` args through their own state to correlate.

### D2. Emission channel (locked by Q2 → A)

**Decision**: NDJSON payload on stdout only. No `suggestion` field. Human-readable prose (`epic complete 🎉`, `queue P2?`) is the watch **plugin's** responsibility, derived from the payload exactly as it does for every other event type (agency#386).

**Rationale**: Embedding presentation in the machine contract couples the engine to slash-command wording — every rewording is an engine change. The plugin already renders assist text from event payloads for `label-change`, `pr-merged`, etc.; extending to aggregate events is a plugin-side task, not an engine one.

### D3. Aggregate state placement

**Decision**: Aggregate state (`Set<string>` of phase keys previously seen complete, `boolean` for epic previously complete) lives in the `watch.ts` poll shell, alongside `prev: SnapshotMap`. `computeAggregateEvents` is a pure function `(currMap, parsed, prevAggState, now) → { events, nextAggState }`.

**Rationale**: `runOnePoll` is pure over `(prev, curr)` and produces per-poll transitions. Aggregate state persists across polls but is not per-poll input — it belongs to the shell, mirroring how `prev: SnapshotMap` is threaded through the loop.

**Rejected**: Threading aggregate state into `PollDeps` — couples pure poll semantics to shell-owned lifecycle.

### D4. Emission ordering (locked by Q4 → A)

**Decision**: In `watch.ts`, after `runOnePoll` returns: (1) `emit()` all per-issue events in existing order; (2) `emitAggregate()` all `phase-complete` events in body order; (3) `emitAggregate()` `epic-complete` last if firing.

**Rationale**: Preserves cause-precedes-effect (last `issue-closed` visible before the `phase-complete` it triggered) and guarantees `epic-complete` is the final line ever written. Auto-mode consumers can rely on the terminator being final without regex-scanning the stream.

**Rejected**:
- Aggregates first (Option B): inverts causality.
- Interleaved by issue (Option C): under-determined when multiple phases complete in one poll.

### D5. Empty phase handling (locked by Q3 → B)

**Decision**: Phase with `refs.length === 0` counts as trivially complete for `epic-complete` aggregation but **never** emits `phase-complete`. One stderr warn at watch startup per empty phase.

**Rationale**: Firing `phase-complete` for an empty placeholder would drive auto-mode to a nonsense "queue the next phase?" gate at startup. Treating it as incomplete would deadlock `epic-complete` on a heading typo. The startup warn matches the existing epic-body-grammar silent-drop-warning precedent.

### D6. Phase-less epic (locked by Q5 → A)

**Decision**: `parsed.phases.length === 0` → `epic-complete` fires when every ref closes; `phase-complete` never fires; `--exit-on-epic-complete` still triggers exit.

**Rationale**: The termination edge must not depend on epic body formatting. Auto-mode on a phase-less epic still needs to know when to stop.

### D7. `--exit-on-epic-complete` flush semantics

**Decision**: After emitting the `epic-complete` NDJSON line, await stdout drain (`await new Promise(r => process.stdout.write('', r))`) before `process.exit(0)`.

**Rationale**: Node's `process.exit` does not flush buffered stdio under pipe consumers. Without the drain, the terminal edge can be truncated when watch is invoked as `generacy cockpit watch … | jq …`.

### D8. `not_planned` closures count as done

**Decision**: Aggregate completion checks `snapshot.state === 'CLOSED'` regardless of `stateReason`.

**Rationale**: Spec-explicit ("state-dominates-labels semantics per #873"). A ticket closed as won't-fix still frees the phase for the next queue step.

### D9. Startup sweep marks with `initial: true`

**Decision**: When the poll shell starts with `prev.size === 0` and the first-poll `curr` shows phases already fully closed, emit `phase-complete` with `initial: true`. Same for a pre-completed epic.

**Rationale**: Matches the existing `computeInitialSweep` convention in `diff.ts` for per-issue events. Consumers are already idempotent (auto-mode's phase-queue action is state-checked); the `initial` flag lets a UI distinguish "this just happened" from "this was already true when I attached."

## Implementation patterns

- **Zod schema for aggregate events**: mirrors `CockpitEventSchema` in `emit.ts`. Discriminated union on `type: 'phase-complete' | 'epic-complete'` where `phase-complete` requires `phase: string` and `epic-complete` forbids it.
- **Emission helper**: `emitAggregate(event, opts)` mirrors `emit(event, opts)` — single `stdout.write` per line, dev-time zod validation, `skipValidate` opt-out for hot paths.
- **Phase key**: `phase.token` (already lower-cased, first-token-per-heading — the field `parsed.phases[i].token`). Stable across polls; safe as the `Set<string>` key.
- **Body order for `phase-complete` emissions**: iterate `parsed.phases` in index order, emit each newly-complete phase's event.
- **Epic-complete condition**: every ref in `parsed.allRefs` has a `snapshot.state === 'CLOSED'` in `curr`, AND `curr.size === parsed.allRefs.length` (guard against missing snapshots — a query error masking incompleteness).

## Key sources / references

- `packages/generacy/src/cli/commands/cockpit/watch/emit.ts` — CockpitEventSchema pattern.
- `packages/generacy/src/cli/commands/cockpit/watch/diff.ts` — `computeInitialSweep` initial-sweep pattern.
- `packages/generacy/src/cli/commands/cockpit/watch.ts` — loop shell, `SnapshotMap` lifecycle.
- `packages/cockpit/src/resolver/types.ts` — `ParsedEpicBody`, `ParsedPhase`, `IssueRef`.
- `packages/generacy/src/cli/commands/cockpit/status/group.ts` — `(no phase)` bucket handling (informs aggregation exclusion rule).
- tetrad-development `docs/epic-cockpit-plan.md` §Auto mode (referenced from spec).
- agency#386 — self-contained-commands / plugin-narrates-engine-decides principle.
- #873 — state-dominates-labels semantics (justifies `not_planned` counting as done).
- #836 — timer un-ref caveat (informs any new `setTimeout` in `--exit-on-epic-complete` drain path — none needed since flush uses `write` callback, not a timer).
