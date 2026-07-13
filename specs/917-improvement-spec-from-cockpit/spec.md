# Feature Specification: Improvement spec from the cockpit v1

**Branch**: `917-improvement-spec-from-cockpit` | **Date**: 2026-07-11 | **Status**: Draft

## Summary

Improvement spec from the cockpit v1.5 auto-mode smoke test efficiency workstream (data: generacy-ai/tetrad-development#92, run-7 ledger). Companion to agency#403 (playbook-side cost contract); independent, but the two compose — #403 cuts per-event weight, this cuts event-delivery turn count and eliminates CLI syntax-negotiation turn classes.

## Motivation (from the snappoll run, 2026-07-10)

The auto session drives everything through Bash + the cockpit CLI. Observed costs that are transport-caused, not engine-caused:

- **Syntax-negotiation rounds**: `--help` lookups, argument-kind confusion (`<pr-ref>` vs `<issue>` — the finding-#49/#50 class, agency#398 / generacy#906), shell quoting and tempfile ceremony for comment bodies.
- **Re-parsing**: every `cockpit status --json` / `context` result is JSON inside shell text the model re-reads and re-serializes into its reasoning.
- **Event delivery granularity**: ~100 watch events each arrived as a separate wakeup → a separate dispatch round. Most were transient. Turn count, not tool-result bulk, is the dominant context driver (~4–5k tokens of growth per round).

## Design

**1. `generacy cockpit mcp` — a stdio MCP server exposing the cockpit verb set as typed tools.**

- Tools mirror the CLI verbs 1:1 and call the **same internal functions** (one implementation, two transports; no shelling out to itself): `cockpit_status`, `cockpit_context`, `cockpit_queue`, `cockpit_advance`, `cockpit_resume`, `cockpit_merge`.
- Typed parameters: `issue` is `{owner, repo, number}` or a validated ref string; a number that resolves to a PR is a **schema-level/typed error** with guidance (subsumes generacy#906's guard at this transport). Gate names validated against the gate vocabulary.
- Structured results: the discriminated-union shapes the CLI already emits as JSON, returned as tool results directly — no stdout parsing. Errors are typed results (`{status: "error", class, detail}`), never bare non-zero-exit text.
- The CLI remains canonical and fully supported (scripts, humans, worker-side code paths); the MCP server is an additional transport for interactive agent sessions.

**2. `cockpit_await_events` — long-poll event delivery with batching (the coalescing lever).**

- `cockpit_await_events({epic, cursor, maxWaitMs, coalesceWindowMs, maxBatchSize})` → `{events: [...], cursor, resetFrom?}`. Blocks until ≥1 event or timeout; after the first event, waits `coalesceWindowMs` to batch the burst that typically accompanies it (label add/remove pairs, phase chains), then returns.
- **Concrete defaults (Q1)**: `maxWaitMs=55000`, `coalesceWindowMs=3000`. Rationale: stdio server on same container — no network keepalive constraint. 55s halves idle wakeups vs 25s; 3s covers both single-issue label bursts (~1–2s) and near-simultaneous sibling clusters at phase boundaries. Both per-call tunable. Locked in the SC-006 fixture.
- **Delivery batching, never filtering** (agency#394 invariant): every event S8/watch would emit appears in some batch, verbatim, in order, with the uniform `type` discriminator (#887). Cursor semantics make re-arms idempotent and crash-safe (same cursor → same tail).
- **Batch size cap (Q5)**: caller-controlled optional `maxBatchSize` with server default `256`, soft-cap semantics. When exceeded, batch closes early (before `coalesceWindowMs`) and returned cursor points at the next undelivered event; caller re-arms immediately for the next chunk. Ordering + verbatim guarantees intact; no `truncated` flag needed (the cursor is the continuation).
- **Invalid cursor handling (Q3)**: discriminated response.
  - Malformed / never-issued cursor → typed error result `{status: "error", class: "invalid-cursor", detail: ...}`. Caller bug; fail loud.
  - Expired / discarded cursor (server restart, retention TTL) → silently reset to head; returned result includes `resetFrom: "expired"` (or similar) as a load-bearing signal that events may have been missed and the caller's recovery mechanism (startup sweep) should engage.
- One batch → one dispatch round in the auto session: on the snappoll profile this alone cuts watch-derived rounds roughly in half or better.
- Implementation: same event source as `cockpit watch` (which stays for humans/scripts).

**3. Orchestrator-only registration.**

- **Not** via `.mcp.json` — that file is repo-scoped: worker containers check out the same repo and would inherit the server (context bloat in every phase agent), and it pollutes the target project's own config surface.
- The scaffolder's `entrypoint-orchestrator.sh` registers the server at **user scope inside the orchestrator container only** (`claude mcp add --scope user cockpit -- generacy cockpit mcp`, or writing the orchestrator's `~/.claude.json`). Worker entrypoints add nothing.
- **Registration conflict handling (Q4)**: overwrite unconditionally when the entrypoint finds an existing `cockpit` entry whose command differs from the target. Emit one idempotent log line noting the reconciliation. Rationale: the entrypoint is the source of truth; cluster upgrades (`generacy update`) must self-heal invocation-path changes, and hand-edits inside the orchestrator container are edits to a rebuildable artifact. No relay event in v1 (no consumer for it yet).
- Defense in depth: `cockpit mcp` refuses to start (clear error) when a cluster-role env marks the container as a worker — merge/advance capability should be structurally absent from workers, consistent with the control-plane topology (workers already cannot reach orchestrator-local capabilities).
- **Role env var (Q2)**: introduce a new `GENERACY_CLUSTER_ROLE` env var set by the compose scaffolder — `orchestrator` on the orchestrator service, `worker` on the worker service. `cockpit mcp` refuses to start when `process.env.GENERACY_CLUSTER_ROLE === 'worker'`. Naming the role explicitly is broadly useful beyond this backstop (vs. inferring from `GENERACY_WORKER_ID` presence or the absence of orchestrator-only artifacts). Requires a companion cluster-base entrypoint change; scaffolder and cloud-deploy compose generation must land in lockstep (documented drift hazard).
- Keep scaffolder and cloud-deploy in lockstep for this entrypoint change (known drift hazard).

## Out of scope

- Migrating auto.md/clarify.md to call the MCP tools — agency follow-up **after** this ships, written against the shipped tool contract (tool names + schemas above are the interface freeze candidates).
- Replacing or deprecating any CLI verb; `cockpit watch` NDJSON stays.
- gh-shape resolver fixes (generacy#913) — transport-independent, tracked separately.

## Success criteria

- An auto session (post-migration) completes an epic with zero Bash invocations of cockpit CLI verbs and zero `--help` consultations.
- A malformed ref (PR number as issue) is rejected at the tool layer with actionable guidance — no engine round-trip, no diagnosis turn.
- Event-driven dispatch rounds for a comparable 12-issue epic drop ≥2× (transcript-measured) via batching.
- Worker containers show no cockpit MCP server in `claude mcp list`; starting `cockpit mcp` in a worker exits non-zero with the role error.

## Regression coverage

- Tool-schema tests: valid/invalid refs, gate vocabulary, PR-number rejection message.
- `cockpit_await_events`: batching within the window, no event loss across cursor resumes, verbatim event bodies (byte-equal to watch NDJSON lines), ordering.
- Parity tests: each MCP tool result deep-equals the corresponding CLI `--json` output for the same fixture state.
- Entrypoint: orchestrator registers user-scope server; worker entrypoint does not; role-env refusal path.


## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
