# Clarifications for #974 — `generacy cockpit doorbell` verb

## Batch 1 — 2026-07-17

### Q1: Cross-process bus sharing
**Context**: `event-bus-registry.ts` holds the `Subscription` map in a module-scoped `Map`. When the skill spawns `generacy cockpit doorbell <epic-ref>` as a new Node process (via harness `Monitor`), that process gets its own registry — the MCP server's `cockpit_await_events` bus lives in a different process, so `acquireEpicBus()` in the doorbell process can never share the MCP server's bus. FR-004 ("attach to the shared bus via `acquireEpicBus()`") and SC-002 ("refcount == 2, only ONE poll loop") therefore cannot be satisfied by a plain CLI subprocess. The spec's Assumptions §3 explicitly leaves this to planning. This is the single decision that determines whether the implementation is a small CLI verb or a new IPC surface.

**Question**: How should the doorbell process share bus state with the MCP-server process running `cockpit_await_events`?

**Options**:
- A: **Doorbell talks to the MCP server** over its existing MCP transport (stdio/socket): the CLI acts as an MCP client, invokes `cockpit_await_events` in a loop, and emits one stdout line per returned event. The bus lives entirely in the MCP-server process; FR-004 and SC-002 hold literally.
- B: **Long-lived orchestrator daemon**: extract the poll driver into an orchestrator (or control-plane) service exposed over a Unix socket. Both the MCP server and the doorbell process connect as clients. New surface; solves the poll-collapse cleanly but is out of scope of the spec's Summary wording.
- C: **Relax SC-002 to "one poll loop per process"**: the doorbell runs its own in-process `acquireEpicBus()` with its own poll loop. Total poll load stays at 2× per epic (doorbell + MCP), unchanged from the pre-#970 `cockpit watch` + `cockpit_await_events` shape. FR-004 stays as-written but its "shared" contract now means "shared within the doorbell process only". SC-002's `refcount == 2` becomes untestable across processes; the SC would be rewritten to a single-process assertion.
- D: **Doorbell runs inside the MCP-server process**: the `doorbell` CLI verb becomes a wrapper that discovers the running MCP server and asks it to open a doorbell channel to stdout. Requires a control channel between CLI and MCP server that does not exist today.

**Answer**: *Pending*

### Q2: `--tracking` / `--new` semantics
**Context**: `auto.md` (agency) arms the doorbell under three forms — epic (`<epic-ref>` positional), tracking-existing (`--tracking <ref>`), and tracking-new (`--new "<title>"`). FR-003 says "`<epic-ref>` positional stays required unless `--new` is passed" — but the spec doesn't say what `--tracking` implies for the positional, what ref the doorbell attaches to under each form, or what happens under `--new` before the tracking issue is created (auto.md defers Form 3's ledger header until G.6 approval — meaning at spawn time under `--new`, no tracking issue exists yet). `EpicEventBus` is keyed on any ref that `resolveIssueContext` can expand, so a tracking-issue ref works fine — but `--new` with no ref does not.

**Question**: Under each of the three arming forms, which ref does the doorbell attach its bus subscription to, and what does the doorbell do under `--new` before a tracking issue exists?

**Options**:
- A: **Positional = whatever ref to subscribe to**. Form 1: `doorbell <epic-ref>` → epic bus. Form 2: `doorbell <tracking-ref> --tracking` → tracking-ref bus (same `acquireEpicBus`, different key). Form 3: `doorbell --new "<title>"` (no positional) → the doorbell emits the FR-010 initial-armed line, then blocks on SIGTERM without a subscription (skill degrades to heartbeat-only until the tracking issue is created and a fresh doorbell is spawned).
- B: **`--tracking` takes its own value; positional stays required or is `null` under `--new`/`--tracking`**. Form 1: `doorbell <epic-ref>` → epic bus. Form 2: `doorbell --tracking <ref>` → tracking-ref bus. Form 3: `doorbell --new` → armed-only (as A above). This matches FR-003's flag typography literally.
- C: **Doorbell always resolves to an "epic ref" via the tracking issue's epic link, then subscribes to the epic bus**. Under Form 2/3 the tracking issue is looked up and its epic ref is derived; only the epic bus is ever subscribed. Requires a resolver that today doesn't exist.
- D: **`--new` is refused loudly at the CLI**: the doorbell requires an existing bus subscription target. The skill's Form 3 arm-up is deferred to G.6 approval time (contradicts auto.md's step-2 spawn).

**Answer**: *Pending*

### Q3: Stdout line content
**Context**: FR-005 says "a single-word marker (e.g. the event `type`) is sufficient" and auto.md confirms the parent never parses the line. But the FR must lock down some deterministic content for FR-006 (flush) and SC-003 (1:1) tests to be writable. "Sufficient" is not implementable — pick one.

**Question**: What exactly does each doorbell stdout line contain?

**Options**:
- A: **Fixed sentinel** — a constant word (e.g. `wake\n`) for every event, plus a distinct constant (e.g. `armed\n`) for the FR-010 initial line. Simplest to test; zero observability from the stream.
- B: **Event `type` field** — the `type` string from the emitted `CockpitStreamEvent` (`issue-transition`, `epic-complete`, `epic-refresh`, etc.). No JSON, no ref — just the type. Modest observability while tailing.
- C: **`<type> <ref>` two-word marker** — e.g. `issue-transition owner/repo#42\n`. Useful for debug `tail -f`, still zero contract with callers.
- D: **NDJSON envelope** — full `{ "type": "...", "ref": "...", "ts": "..." }` on each line. Turns the doorbell into a redundant `cockpit watch`; violates the "doorbell only" contract.

**Answer**: *Pending*

### Q4: Event filter
**Context**: `runRealCycle` emits (a) one `issue-transition` event per state change from `runOnePoll`, and (b) 0+ aggregate events (`epic-complete`, `epic-refresh`, `phase-complete`, etc.) from `computeAggregateEvents`. Every event currently reaches `bus.emit()`. FR-005 says "one line per event received" — which events count?

**Question**: Which events on the shared bus produce a doorbell line?

**Options**:
- A: **All events, 1:1 with `bus.emit()`** — no filtering. Simplest. Aggregate events (like `epic-refresh`, fired at cycle boundaries) produce wake signals even when nothing user-visible changed.
- B: **Only `issue-transition` events** — aggregate/lifecycle events are skipped. The doorbell wakes exclusively on real per-issue state changes.
- C: **All events except an explicit noise-list** — e.g., exclude `epic-refresh` but include `epic-complete`, `phase-complete`, and `issue-transition`. Requires the spec to enumerate the noise-list.
- D: **All events, plus FR-010 initial-armed** — same as A but the "armed" line is a distinct event that does not go through `bus.emit()`.

**Answer**: *Pending*

### Q5: Exit-on-epic-complete
**Context**: `cockpit watch` has an optional `--exit-on-epic-complete` flag that flushes stdout and exits 0 after emitting the `epic-complete` line. The doorbell's Acceptance Criteria say "runs until SIGTERM otherwise" — implying no auto-exit. But auto.md drives the doorbell under harness `Monitor`, and when the epic finishes, the skill terminates the sensor via harness lifecycle. Should the doorbell mirror `watch`'s flag for parity, always run until signal, or auto-exit on epic-complete by default?

**Question**: When the bus emits `epic-complete`, what does the doorbell do?

**Options**:
- A: **Always runs until SIGTERM/SIGINT** — `epic-complete` produces one more stdout line, then the doorbell keeps polling. Simplest; matches Acceptance-Criteria wording. Skill lifecycle is responsible for killing the sensor.
- B: **Add `--exit-on-epic-complete` flag mirroring `watch`** — off by default; when on, flush stdout and `process.exit(0)` after emitting the `epic-complete` line. Parity with `watch`, no behavior change unless the skill opts in.
- C: **Auto-exit on `epic-complete` by default** — no flag; the doorbell always exits 0 after flushing the `epic-complete` line. Matches the "wake sensor for one epic" mental model, but breaks Form 2/3 (tracking-issue doorbells never emit `epic-complete`).
- D: **No exit; also do not emit a stdout line for `epic-complete`** — hides completion behind SIGTERM entirely.

**Answer**: *Pending*
