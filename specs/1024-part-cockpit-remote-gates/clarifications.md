# Clarifications — Cockpit gates: cluster-side end-to-end integration test (#1024)

## Batch 1 — 2026-07-21

### Q1: Doorbell answers-file position persistence
**Context**: FR-007 (restart replay) hinges on how the doorbell knows where to resume after a mid-flow restart with unacked answers still in the answers file. The three plausible models change what "replay exactly once" means in the assertion and where the harness's hook belongs (filesystem sidecar vs. MCP-bus registry vs. dedup layer).
**Question**: Which position-persistence model does the doorbell use when it restarts with unacked answers still present in the answers file?
**Options**:
- A: **On-disk sidecar** — the doorbell writes its file offset to a companion file (e.g., `answers.ndjson.pos`) on every emit; on restart it resumes from the persisted offset, so already-emitted lines are skipped by position alone.
- B: **Recomputed from unacked state on start** — the doorbell asks the MCP event-bus (or an in-memory ack registry) which `deliveryId`s are already acked and skips them, but always re-reads the file from head.
- C: **Always re-read from head, dedup as the guard** — the doorbell holds no persisted position; every restart re-tails from the beginning and relies on `deliveryId` dedup at the MCP-bus / session layer to prevent double delivery.

**Answer**: *Pending*

### Q2: `deliveryId` dedup ownership
**Context**: FR-008 requires "one file line, one doorbell stdout event, one `cockpit_await_events` batch entry" across duplicate injections. Which layer holds the dedup state determines where the harness must assert (byte-count the file, count stdout lines, count bus entries — or all three) and which sibling P1 issue owns the fix if the dedup breaks.
**Question**: Which layer is responsible for `deliveryId` dedup?
**Options**:
- A: **Orchestrator's answers-file writer only** — dedup happens before write; the file contains at most one line per `deliveryId`, and downstream layers assume file lines are unique.
- B: **Doorbell only** — dedup happens before emit; the file may contain duplicates (append-only audit log), but the doorbell tracks seen `deliveryId`s in-memory and never emits the same one twice.
- C: **Both layers, file as the audit record** — writer dedups so the file stays clean AND the doorbell dedups on top to survive restart replays where a `deliveryId` was already emitted before the crash but the file line stays.

**Answer**: *Pending*

### Q3: Harness process model
**Context**: NEEDS-CLARIFICATION-3 in the spec. In-process is faster and easier to assert against but does not exercise the real spawn/exit path; child processes prove the spawn/exit lifecycle at the cost of speed and determinism. FR-007 (kill and restart the doorbell mid-flow) in particular is only fully meaningful if the doorbell is a real child process.
**Question**: How are the orchestrator, doorbell, and MCP event-bus booted inside the harness?
**Options**:
- A: **All in-process under Vitest** — direct function calls into the orchestrator's Fastify app, the doorbell's tail loop, and the MCP bus registry. Fastest; restart is simulated by disposing and re-constructing the doorbell object.
- B: **All as real child processes with IPC** — `spawn()` for orchestrator, doorbell, and MCP server; proves the real spawn/exit lifecycle at every seam.
- C: **Hybrid** — orchestrator + MCP bus in-process, doorbell as a real child process (since FR-007's kill-and-restart assertion is only meaningful against a real `spawn()`).

**Answer**: *Pending*

### Q4: Failure-mode coverage
**Context**: NEEDS-CLARIFICATION-4 in the spec. The Scope section lists only five happy-path scenarios; adding failure modes closes more P1 seams but expands scope beyond what the issue text describes. Which cut lands here vs. deferred to per-sibling unit tests changes the harness's size and reviewer expectations.
**Question**: Should this harness cover documented failure modes in addition to the five happy-path scenarios in Scope?
**Options**:
- A: **Happy-path only** — assert exactly the five scenarios listed in Scope; failure modes (malformed answer, invalid gate open, rotation, disconnect mid-ack) are deferred to per-sibling unit tests in the four P1 sibling issues.
- B: **Happy-path + a targeted failure-mode set** — add three specific assertions: (i) malformed answer NDJSON line is skipped-and-logged (doorbell does not crash), (ii) `POST /cockpit/gates` with an invalid gate record returns 4xx and emits **no** `cluster.cockpit` event, (iii) doorbell tolerates answers-file rotation without losing pending unacked lines.
- C: **Full failure-mode sweep** — every documented failure mode across all four P1 siblings is asserted here, on the argument that this issue is the integration-seam closer.

**Answer**: *Pending*
