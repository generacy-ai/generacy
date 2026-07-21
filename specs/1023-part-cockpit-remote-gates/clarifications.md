# Clarifications — #1023 Cockpit doorbell: tail answers file → gate-answer events

## Batch 1 — 2026-07-21

### Q1: Multi-epic filtering
**Context**: The answers file lives at a cluster-wide path (`/workspaces/.generacy/cockpit/answers.ndjson`), but each `/cockpit:auto` session spawns its own doorbell process bound to a single epic (`epicRef`). If two epics run concurrently in the same cluster, both doorbell processes read the same file, and each line's `gateId` implicitly belongs to exactly one epic. Deciding where the scope filter lives (tailer vs. downstream) shapes FR-005/FR-006 emission, US2's "for the driving epic scope" wording, and the `gate-answer` variant on `CockpitStreamEvent` (which today has no epic-scoping field).
**Question**: Should the doorbell tailer filter answers-file lines by the epic the process is bound to before emitting them, or should it emit every valid line to both consumers (stdout + event bus) and leave scope filtering to a downstream consumer (D.12 dispatch / harness)?
**Options**:
- A: Tailer filters. It resolves each line's owning epic from the payload (e.g., a `scope`/`epic` field on the answer line, or by resolving `gateId` against the epic ref-set the smee source already tracks) and only emits lines that match `epicRef`. Other-epic lines are dropped silently (no log).
- B: Tailer is scope-blind. Every valid line is emitted to both consumers on every doorbell process; the D.12 dispatch (agency P4) is the sole gate that filters by `gateId` ownership. `CockpitStreamEvent.gate-answer` variant carries no scope field beyond what the writer wrote.
- C: Tailer filters, and drops of other-epic lines are logged at `info` with the `gateId` so operators can see cross-epic traffic without silencing the stream.

**Answer**: C — Tailer filters by the bound `epicRef` and logs dropped cross-epic lines at `info` with the `gateId`.
**Rationale:** The event-bus is strictly per-epic (distinct `wrong-epic` cursor class), so cross-epic lines must be filtered at the tailer before reaching the bus/stdout — a scope-blind tailer would poison the per-epic bus and mis-deliver another epic's answers; answer traffic is human-paced/low-volume, so an `info` log per drop is cheap and directly serves the operator-diagnosability concern.

### Q2: Directory absence at start
**Context**: FR-002 covers the file-does-not-exist case, but the parent directory `/workspaces/.generacy/cockpit/` may also be absent when the doorbell starts (fresh cluster, before the orchestrator route ever runs). Whether the tailer creates the directory, waits for it, or refuses to start affects startup ordering vs. the orchestrator route (sibling P1 issue) and shows up as a real test path (US3 AC3 — "created between doorbell start and first append" — is silent on the directory case).
**Question**: If the parent directory does not exist when the tailer starts, what is its behavior?
**Options**:
- A: Tailer creates the directory with default permissions (`mkdir -p`) and proceeds to wait for the file. Never fails on a missing parent.
- B: Tailer waits for the directory (poll or `fs.watch` on the grandparent) exactly the same way it waits for the file. Never creates.
- C: Tailer treats a missing parent directory as a fatal startup error and refuses to start. The orchestrator (or an entrypoint script) is responsible for creating the directory before the doorbell runs.

**Answer**: B — Tailer waits for the parent directory (poll or `fs.watch` on the grandparent) the same way it waits for the file; it never creates the directory.
**Rationale:** The answers file is single-writer-owned by the orchestrator route (which creates the parent dir like the smee-channel workspace mirror); a read-only doorbell also doing `mkdir` creates two owners with possibly divergent mode/uid. Extending the existing file-wait to the parent dir is minimal and never fatally fails on a fresh cluster.

### Q3: Replay-then-live ordering vs. concurrent smee events
**Context**: FR-003 says the tailer emits all N pre-existing lines "before entering the polling / watch loop for new appends" — but the smee-source runs concurrently in the same process against the same stdout writer and event bus. During the startup drain, smee events for the same epic may arrive. Whether they interleave into the pre-replay window changes the guarantees for US3 (restart replay) and the shape of SC-003's "N lines on both consumers, in file order, before any post-start append" assertion.
**Question**: During startup replay of pre-existing answers-file lines, may smee-source events for the same epic interleave into the stdout stream / event-bus emissions?
**Options**:
- A: Interleaving is allowed. FR-003's "before" is scoped to the answers-file source only ("before entering the answers-file watch loop"); smee events continue to emit as they arrive. Consumers must not assume answer replay is atomic w.r.t. smee events.
- B: The tailer holds a startup-drain barrier that briefly blocks smee-source emissions (or serializes them behind the drain) until the N pre-existing answer lines have all emitted. Cross-source ordering is preserved only within this startup window; steady-state interleaving reverts to today's monotonic-cursor-only rule (FR-010).
- C: The tailer completes its drain synchronously in `start()` before returning; the smee source is only started after `start()` resolves. Startup drain and smee-live are strictly sequential at the process level.

**Answer**: A — Interleaving is allowed: FR-003's "before" is scoped to the answers-file source only; smee-source events keep emitting as they arrive.
**Rationale:** The event-bus assigns a monotonic per-emit cursor regardless of source, and gate-answers vs issue-transitions are semantically independent (the session dedups answers by `deliveryId` and validates gate currency), so cross-source ordering carries no correctness value; a startup-drain barrier would stall the smee liveness path (the doorbell's primary wake source) behind a potentially long replay for zero benefit.

### Q4: Warn-log destination for malformed lines
**Context**: FR-004 says malformed lines are logged at `warn` and include file path + line/offset + `gateId` (if extractable). The doorbell process today writes structured NDJSON events to **stdout** (watched by the harness Monitor tool) and status transitions to **stderr**; `SmeeDoorbellSource` takes a `logger: { warn, info }` callback that the caller wires however it likes. The choice matters because the Monitor tool splits on stdout NDJSON lines, so a bare `warn(...)` written to stdout could contaminate the event stream, but a stderr-only log is invisible to the harness.
**Question**: Where should the tailer's malformed-line `warn` entries go?
**Options**:
- A: Delegate to the same `logger: { warn }` callback that `SmeeDoorbellSource` uses. The doorbell entrypoint decides the sink today (typically `process.stderr.write(...)`), and this issue does not change that contract. Stdout stays event-only.
- B: Write directly to `process.stderr` from the tailer (bypassing `logger`), to match the `stderr` conventions of `startup-retry.ts` / `source-selector.ts`. `logger` is not used.
- C: Emit malformed-line reports as a distinguished NDJSON line on stdout (e.g., `{type: "doorbell-warning", ...}`) so the harness Monitor tool can surface them. Requires adding a new `CockpitStreamEvent` variant.

**Answer**: A — Delegate to the same `logger:{warn}` callback that `SmeeDoorbellSource` uses (entrypoint wires it to stderr by default); stdout stays event-only.
**Rationale:** All sibling components (`SmeeDoorbellSource`, `source-selector`, `startup-retry`) take an injected `logger:{warn,info}` seam, so delegating malformed-line warnings there is the established convention; emitting them as stdout NDJSON would pollute the stream the harness Monitor parses (and needlessly add an event variant), and writing directly to stderr bypasses the shared abstraction.

### Q5: Replay-size ceiling
**Context**: FR-003 requires reading the entire existing file from offset 0 on start. Assumptions note that "long-run cost is bounded by the orchestrator's rotation policy" (sibling issue) — but that sibling has not landed, and there is no upper bound in this spec on how large the file may be at doorbell start. A cluster that runs for weeks without rotation, or one with a broken rotation policy, could present a multi-GB file to the tailer. Whether this issue owns any defensive ceiling affects memory profile, startup latency (SC-001 is silent on startup), and whether the tailer must stream vs. read-into-memory.
**Question**: Does this issue impose an explicit ceiling on how much the tailer replays at start?
**Options**:
- A: No ceiling. The tailer streams the file line-by-line regardless of size and relies on the orchestrator's rotation policy as the sole bound. Memory is bounded by one line at a time; startup latency scales with file size and is uncapped.
- B: Byte ceiling. If the file exceeds a fixed size at start (e.g., 100 MB), the tailer skips ahead to the last N bytes, emits from there, and logs a `warn` naming the skipped range. Prevents pathological startup time at the cost of losing pre-cap history.
- C: Line-count ceiling. Same shape as B but expressed as "last N lines" (e.g., last 10 000), which is closer to the retention semantics of the in-process event bus (`retentionCount = 10 000`).

**Answer**: C — Line-count ceiling: replay the last ~10,000 lines.
**Rationale:** The in-process event-bus retains only `retentionCount=10000` entries, so replaying more than that is wasted work `cockpit_await_events` can never surface; a line-count cap aligns the replay window exactly with the bus retention window and does not depend on the not-yet-landed rotation sibling as its sole bound.
