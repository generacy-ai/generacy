# Research: Cockpit doorbell — tail answers file → gate-answer events

**Feature**: #1023 | **Branch**: `1023-part-cockpit-remote-gates`

## R-1 — Wake path integration (new source vs. reuse smee-source vs. reuse poll cycle)

**Decision**: Add a **new peer source** (`AnswersFileSource`) alongside `SmeeDoorbellSource` and the poll-bus subscriber, running concurrently and emitting into the same `EpicEventBus` + stdout writer.

**Alternatives considered**:

- **Reuse `SmeeDoorbellSource`** (rejected): the smee source is bound to an SSE reconnect ladder, ref-set aggregate refresh, and GitHub webhook payload parsing. None of that applies to a local NDJSON tailer. Overloading it would fragment the reconnect/refresh state machine and complicate its unit tests.
- **Reuse the poll cycle** (rejected): `runOnePoll` (`mcp/event-bus-registry.ts:410`) is a GitHub-facing HTTP poll driven by `RateLimitScheduler`. Piggybacking a file tailer would drag GitHub rate-limiting into a filesystem read.
- **Fold the tailer into `source-selector`** as a new `SourceMode` (rejected): the selector models mutually-exclusive wake paths (smee vs. poll). The answers tailer runs in *parallel* with whatever source the selector picks. Making it a selector state would either force smee/poll off (starving the primary wake path) or require a "both" state (breaking Q3-A's design that treats sources as independent producers).

**Sources**:
- Spec §Context: "The driving session must see them as events on its existing wake paths."
- Spec Q3 answer (A): "smee-source events keep emitting as they arrive" — independence between sources is baked into the spec.

## R-2 — Tail mechanism (`fs.watch` vs. poll vs. hybrid)

**Decision**: **Hybrid** — `fs.watch` on the parent dir for change notifications + a 2 s fallback poll. On each event/tick, `stat()` the file and compare `(ino, size)` against the last-observed pair.

**Rationale**:

- `fs.watch` is unreliable across bind mounts / tmpfs / overlay FS — precisely the layout used by cluster-base for `/workspaces/.generacy/`.
- Pure poll wastes wake-ups on the idle path; 2 s poll interval is acceptable for human-paced gate answers but hurts CPU when there's nothing to see.
- Hybrid: `fs.watch` covers the common good case with sub-second latency; poll is the safety net for missed events (mirroring `SmeeDoorbellSource.safetyNetIntervalMs`).
- `(ino, size)` pair captures both rotation (ino change → reopen at 0, subject to 10 000-line replay cap) and truncation (ino same, size dropped → reopen at 0).

**Alternatives considered**:

- **Pure `fs.watch`**: rejected — silent event loss on bind-mount / tmpfs.
- **Pure poll**: rejected — wastes wake-ups; a doorbell that fires 43 200×/day for zero work is a bad neighbour.
- **`tail -F` subprocess**: rejected — subprocess dependency + rotation-semantics parsing from stderr.
- **`chokidar`**: rejected — extra dep for behaviour we already achieve with `node:fs` + `stat()`.

**Sources**:
- Node docs: `fs.watch` caveats on non-native filesystems (Linux inotify semantics vs. macOS FSEvents, bind mount interactions).
- Existing codebase: `SmeeDoorbellSource.safetyNetIntervalMs` (`doorbell/smee-source.ts:32`) uses the same "primary event stream + fallback timer" pattern.

## R-3 — Startup replay ceiling (byte cap vs. line cap vs. no cap)

**Decision**: **Line-count cap at 10 000 lines**, enforced inside the tailer (Q5 → C).

**Rationale**:

- The in-process `EpicEventBus` retains only the last `retentionCount = 10 000` entries (`mcp/event-bus.ts:138`). Anything below the cap has no client-visible landing: emitting it wastes CPU and stdout bandwidth without adding capability.
- Line cap (not byte cap) aligns exactly with the bus retention semantics; a byte cap would drift out of alignment as answer-line length changes over time.
- Enforced in the tailer (not the bus) so we can emit exactly one `warn` naming the skipped range on truncation — a bus-side cap would be structurally unable to warn.

**Alternatives considered**:

- **No ceiling** (spec Q5 option A): rejected — a broken rotation policy on a long-lived cluster could present a multi-GB file at doorbell start; startup latency uncapped.
- **Byte ceiling at 100 MB** (spec Q5 option B): rejected — drifts out of alignment with the bus retention window; produces variable line count depending on line size.

**Sources**:
- Spec Q5 answer (C).
- `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts:138` — `retentionCount ?? 10_000`.

## R-4 — Directory absence at start (create vs. wait vs. fatal)

**Decision**: **Wait** for the parent directory the same way the tailer waits for the file (Q2 → B).

**Rationale**:

- The answers file is single-writer-owned by the orchestrator route (sibling P1 issue). Two owners with divergent `mkdir` timing could produce divergent mode/uid.
- Fresh clusters typically start the orchestrator + doorbell concurrently; a `mkdir` from the doorbell is a race, not a fix.
- A "wait" is a trivial extension of the file-wait code — reuse the same `(fs.watch(parentGrandparent), poll)` pattern one level up.
- Fatal-on-missing-parent (spec Q2 option C) would make the doorbell fragile on fresh clusters; entrypoint scripts should not need to `mkdir` on behalf of a read-only consumer.

**Sources**:
- Spec Q2 answer (B).
- Sibling pattern: `SmeeDoorbellSource` polls channel-file discovery (`doorbell/channel-discovery.ts`) with the same "wait, don't create" discipline.

## R-5 — Malformed-line logging destination

**Decision**: **Injected `logger.warn` callback** — same seam as `SmeeDoorbellSource`, `source-selector`, `startup-retry`.

**Rationale**:

- Every sibling doorbell component takes a `logger: { warn, info? }` injection; matching the convention keeps `runDoorbell()`'s wiring uniform.
- Direct `process.stderr.write` bypasses the shared abstraction; a caller (test, alternative entrypoint) that wants to route warnings elsewhere would have no seam.
- Writing warnings to stdout would pollute the harness Monitor's NDJSON parse — the harness splits on stdout lines and every line is expected to be a valid `CockpitStreamEvent`.
- A distinguished NDJSON `doorbell-warning` event variant was explicitly rejected in Q4 option C.

**Sources**:
- Spec Q4 answer (A).
- Existing pattern: `SmeeDoorbellSourceOptions.logger` (`doorbell/smee-source.ts:40`), `SourceSelectorOptions.logger` (`doorbell/source-selector.ts:21`).

## R-6 — Epic-scope filter location (tailer vs. downstream dispatch)

**Decision**: **Filter at the tailer**, before any bus/stdout emit. Cross-epic lines are dropped and logged at `info` with the `gateId`.

**Rationale**:

- The `EpicEventBus` is strictly per-epic. Its `wrong-epic` cursor class exists to catch cursor cross-contamination between epics — emitting another epic's answers into a per-epic bus is exactly the kind of poisoning the class was designed to detect.
- A scope-blind tailer would either (a) require every downstream consumer to re-filter (redundant work in `subscribeAndEmit`, `cockpit_await_events`, and the eventual D.12 dispatch) or (b) risk mis-delivering another epic's answers.
- Answer traffic is human-paced (< 1 line / gate). An `info` log per cross-epic drop is cheap and directly serves the operator-diagnosability concern.
- Silent drop (spec Q1 option A) was rejected: cross-epic traffic in the answers file is a diagnostic signal (either the writer is emitting to the wrong scope or two epics collided on a `gateId`); operators need to see it.

**Sources**:
- Spec Q1 answer (C).
- `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts:164` — `wrong-epic` cursor class implementation.

## R-7 — Cross-source ordering during startup replay

**Decision**: **Interleaving allowed** during startup replay. No drain barrier. FR-003's "before" is scoped to the answers-file source only.

**Rationale**:

- The bus assigns a monotonic per-emit cursor regardless of source. Callers get "the events emitted, in bus order" — cross-source ordering is not a guarantee callers can rely on.
- A startup-drain barrier would stall the smee liveness path (the primary wake source) behind a potentially long replay for zero correctness benefit — gate-answers and issue-transitions are semantically independent, and the session dedups answers by `deliveryId` and validates gate currency independently.
- Two-phase startup (rejected — spec Q3 option C) would require sequencing `SmeeDoorbellSource.start()` after `AnswersFileSource.start()` resolves, breaking the current parallel-start model in `doorbell.ts`.

**Sources**:
- Spec Q3 answer (A).
- Existing bus contract: `EpicEventBus.emit` (`mcp/event-bus.ts:144`) assigns cursors atomically in the order emits arrive.

## R-8 — Schema authority for the answer NDJSON line

**Decision**: The **wire shape** (field names, `gateId`/`deliveryId` semantics, `scope`/`epic` field, outcome ack, generation rules) is authoritative in the epic-plan doc [`cockpit-remote-gates-plan.md`](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md). This spec captures the **minimum** subset the tailer needs to parse for filtering and emission; the full field list lives in `contracts/gate-answer-line.md` as a summary + upstream pointer.

**Rationale**:

- Spec §Summary explicitly directs "Implement against the contracts as written; propose contract changes on the epic before diverging."
- Duplicating the field list in this repo risks drift when the epic-plan iterates.
- The tailer only strictly needs: (a) the epic-scope field to filter on (Q1), (b) `gateId` for the info log on cross-epic drops (Q1), and (c) a canonical JSON parse that survives round-trip to the `CockpitStreamEvent` variant. Everything else is passed through opaquely for the eventual D.12 dispatch step.

**Sources**:
- Spec §Summary: "wire contracts (gate record, answer NDJSON line, outcome ack, gateId/generation rules): [cockpit-remote-gates-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md)."

## R-9 — `gate-answer` as a new `CockpitStreamEvent` variant

**Decision**: Extend `CockpitStreamEventSchema` with a fourth discriminated-union member (`GateAnswerEventSchema`). The `type` discriminator matches sibling variants (`issue-transition`, `phase-complete`, `epic-complete`).

**Rationale**:

- Zod's `discriminatedUnion` extends cleanly for a new `type: 'gate-answer'` literal — no ambiguity with existing members.
- All existing consumers (`subscribeAndEmit`, `EpicEventBus.emit`, `cockpit_await_events`, `lineForEvent`) operate on the union type and require no changes to accept the new variant.
- Callers that discriminate on `type` (e.g., `subscribeAndEmit`'s exit-on-`epic-complete` branch at `doorbell.ts:187`) simply add a new arm; they do not need to change existing arms.

**Alternatives considered**:

- **Separate stream for gate-answers** (rejected): a second NDJSON stream would fragment the harness Monitor tool's parse — the harness assumes one stdout NDJSON stream per doorbell process.
- **Envelope one CockpitStreamEvent inside another** (rejected): adds structural complexity for zero benefit.

**Sources**:
- Existing pattern: `packages/generacy/src/cli/commands/cockpit/watch/stream-event.ts` — three-member `discriminatedUnion` already established.
