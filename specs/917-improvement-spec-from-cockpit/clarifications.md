# Clarifications

## Batch 1 — 2026-07-11

### Q1: `cockpit_await_events` default timings
**Context**: FR-006 sets `coalesceWindowMs` default at "a few seconds (calibrated to observed burst timing on the snappoll ledger)" and does not name a concrete `maxWaitMs` default at all. Both defaults are load-bearing: SC-003's ≥2× dispatch-round reduction depends on the coalesce window actually covering a typical label add/remove burst, and `maxWaitMs` controls how often an idle epic wakes the agent. Without concrete numbers, tool-schema tests (FR-014 (b)) can't assert behavior and the SC-006 fixture can't decide burst spacing.
**Question**: What are the concrete numeric defaults for `cockpit_await_events`'s `maxWaitMs` and `coalesceWindowMs`?
**Options**:
- A: `maxWaitMs=25000`, `coalesceWindowMs=1500` — matches the "few seconds" language and stays under typical HTTP/WS keepalives.
- B: `maxWaitMs=55000`, `coalesceWindowMs=3000` — closer to SSE-style long-poll (1 min), wider coalesce for lazier bursts.
- C: `maxWaitMs=10000`, `coalesceWindowMs=750` — tighter defaults, prioritizes latency-to-first-batch over burst grouping.
- D: Defer — pick defaults empirically during implementation from the snappoll ledger burst-spacing histogram, record chosen values in `plan.md` and lock via SC-006 fixture.

**Answer**: *Pending*

### Q2: Worker-role identification env var
**Context**: FR-012 requires `generacy cockpit mcp` to refuse to start "when a cluster-role env marks the container as a worker", and the Assumptions section claims "A cluster-role env var identifying worker vs orchestrator already exists (or is trivially added)". Reading the scaffolder (`packages/generacy/src/cli/commands/cluster/scaffolder.ts` lines 213-250), the compose file distinguishes the two services **only by `command:`** (`entrypoint-orchestrator.sh` vs `entrypoint-worker.sh`). `GENERACY_CLUSTER_ID`, `DEPLOYMENT_MODE`, `CLUSTER_VARIANT` are set on both services identically. There is no env-level role marker today. This blocks writing the FR-012 startup check and the SC-004 smoke test.
**Question**: Which env var identifies the container role, and what value marks it as a worker?
**Options**:
- A: Add a new `GENERACY_CLUSTER_ROLE` env var to the compose scaffolder, set to `orchestrator` on the orchestrator service and `worker` on the worker service. `cockpit mcp` refuses to start when `GENERACY_CLUSTER_ROLE=worker`. Requires companion cluster-base entrypoint change.
- B: Reuse `GENERACY_WORKER_ID` (already present in credhelper audit — see [[credentials-architecture]] context) as the signal: presence with a non-empty value = worker. Refuses on `process.env.GENERACY_WORKER_ID` truthy.
- C: Detect via absence of a well-known orchestrator-only artifact (e.g. `ORCHESTRATOR_INTERNAL_API_KEY` from #594, or `/run/generacy-control-plane/control.sock`). No new env var.
- D: Skip the FR-012 backstop entirely for v1; rely on the primary control (workers never register the server) and document that starting `cockpit mcp` in a worker is undefined behavior.

**Answer**: *Pending*

### Q3: Unknown / invalid cursor behavior
**Context**: FR-008 says the cursor is "server-side-opaque and idempotent" and "passing the same cursor returns the same tail", but does not say what `cockpit_await_events` does when it receives a cursor value the server does not recognize — never-issued, malformed, or referring to a position the server has since discarded (retention TTL, restart). SC-008's crash-safety fixture depends on this behavior being explicit. Implementations diverge widely: return typed error, silently reset to "connect-time position", advance to head, etc. Each choice has different agent-visible consequences.
**Question**: How does `cockpit_await_events` respond to an unrecognized / expired / malformed cursor?
**Options**:
- A: Return a typed error result (`{status: "error", class: "invalid-cursor", detail: ...}`) — no events. Caller must decide (re-arm from `undefined`, exit, escalate).
- B: Silently reset to the connect-time position (same as if no cursor was passed) and return events from there. Log a warning server-side but no error to caller.
- C: Advance to head (return only events emitted after the call) and mark the returned cursor as `{resetFrom: "unknown"}` for observability.
- D: Distinguish: malformed / never-issued → error (A); expired / discarded → reset-to-head with a signal (C).

**Answer**: *Pending*

### Q4: Registration conflict handling in the orchestrator entrypoint
**Context**: FR-010 requires the scaffolder's `entrypoint-orchestrator.sh` to register the MCP server idempotently at user scope (`claude mcp add --scope user cockpit -- generacy cockpit mcp` or equivalent `~/.claude.json` write), with "repeat runs do not duplicate the entry". Unspecified: what happens on entrypoint boot when `~/.claude.json` already contains a `cockpit` entry whose command differs from the one this version of `generacy` wants to write (e.g. after an image upgrade that changed the invocation path, or a manual user edit inside the orchestrator container). Overwrite silently, refuse, or preserve determines whether upgrades self-heal or require manual reconciliation.
**Question**: When the entrypoint finds an existing `cockpit` MCP entry in `~/.claude.json` with a different command from the one it would write, what should it do?
**Options**:
- A: Overwrite unconditionally — the entrypoint is the source of truth for this entry; user edits inside the orchestrator container are transient and cluster upgrades self-heal.
- B: Overwrite only when the existing command matches a known prior generacy-managed shape (regex / prefix match on `generacy cockpit mcp`); preserve any hand-edited command and log a warning.
- C: Never overwrite — write only when the entry is absent. Rely on `cluster destroy` / `rebuild` for reconciliation. Log a warning on skip.
- D: Overwrite + emit a `cluster.bootstrap` relay event with `{status: "reconciled", entry: "cockpit", prior, next}` so cloud can surface the change to the operator.

**Answer**: *Pending*

### Q5: Batch size cap for `cockpit_await_events`
**Context**: FR-006 / FR-007 say `cockpit_await_events` "drains any additional events emitted in that window into the same batch" with no cap. In pathological cases (relabel storm, phase chain that fires hundreds of events, catch-up after a long disconnect where the cursor points far behind head), a single batch could contain thousands of events. Every event is a JSON payload; a very large batch inverts the very cost the batching is supposed to reduce (context bloat vs. round count). Conversely, capping the batch shifts one of SC-006's fixture assumptions ("one call returns a batch of N events"). This decision affects both server memory and agent-side context growth.
**Question**: Is there a maximum batch size for `cockpit_await_events`, and if so, how are excess events delivered?
**Options**:
- A: No cap. Batch is however large the source produced within the coalesce window (and the caller can drain further by re-arming with the returned cursor if events keep flowing). Simplest; matches the SC-006 assumption literally.
- B: Soft cap (e.g. 256 events). When exceeded, the batch closes early (before `coalesceWindowMs`) and the returned cursor points at the next un-delivered event; caller re-arms immediately for the next chunk. Preserves ordering + verbatim guarantees; caps context growth per round.
- C: Hard cap with explicit signal (e.g. 512 events + `{truncated: true}` field in the result). Caller decides whether to continue or checkpoint.
- D: Caller-controlled via a new optional `maxBatchSize` parameter with a server default (say 256); soft-cap semantics as in B.

**Answer**: *Pending*
