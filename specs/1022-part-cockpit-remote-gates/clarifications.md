# Clarifications

Feature: cockpit MCP — `cockpit_gate_open` + `cockpit_gate_ack` tools
Issue: [#1022](https://github.com/generacy-ai/generacy/issues/1022)
Branch: `1022-part-cockpit-remote-gates`

---

## Batch 1 — 2026-07-21

### Q1: Error class for cloud-unavailability

**Context**: FR-005 requires a "distinct, matchable error class" for two failure modes so `auto.md --gates=auto` can fall back to `AskUserQuestion` without hanging. The two modes are (i) orchestrator unreachable / network error / 5xx, and (ii) cluster not cloud-activated. The chosen shape becomes part of the MCP tool contract and drives what `auto.md` pattern-matches on. Existing `ErrorClass` union in `mcp/errors.ts:15-27` already has `transport`.

**Question**: Which error-class shape should `cockpit_gate_open` / `cockpit_gate_ack` return for cloud-unavailability?

**Options**:
- A: Reuse existing `transport` for both modes (spec's stated preference — not-activated degenerates to "orchestrator returns 5xx / connection refused" in practice)
- B: `transport` for network/5xx, add new `cloud-inactive` class for the not-cloud-activated case (two-way distinction the skill can dispatch on)
- C: Collapse both under a new dedicated class `gate-cloud-unavailable` (single matchable class, but disjoint from other transports)

**Answer**: *Pending*

---

### Q2: Orchestrator base-URL discovery

**Context**: FR-006 says base-URL discovery "consistent with existing in-cluster callers". Today no cockpit MCP tool calls the orchestrator; the closest analog is control-plane's internal-relay-events forwarder which reads `ORCHESTRATOR_URL` at request time with a `http://127.0.0.1:3100` default. The choice affects test seams (option-bag injection is trivially mockable; env-var reads need `process.env` shims) and consistency with the existing `startMcp()` deps pattern (`BuildMcpServerDeps` in `mcp/server.ts:42`).

**Question**: How should the two tools discover the orchestrator's base URL, and what env var + default should apply?

**Options**:
- A: Read `ORCHESTRATOR_URL` (default `http://127.0.0.1:3100`) at request time inside each tool handler — matches control-plane's pattern, minimal wiring
- B: Thread a `orchestratorBaseUrl` field through `BuildMcpServerDeps` and `startMcp()` options, populated at bootstrap from the same env var — matches the existing MCP-server injection convention
- C: Both — options-bag override with env-var fallback (env is default; options bag lets tests inject without shimming `process.env`)

**Answer**: *Pending*

---

### Q3: CLI verb parity

**Context**: FR-009 flags that the other twelve cockpit MCP tools each wrap an underlying `run<Verb>()` CLI function (design invariant #1 in `mcp/server.ts`). `cockpit_gate_open` / `cockpit_gate_ack` have no natural CLI counterpart — they are only useful from the driving `/cockpit:auto` session and would leak raw HTTP-client behavior if exposed as `generacy cockpit gate-open`. Adding CLI verbs anyway would expand the CLI surface for zero user-visible benefit; skipping them creates the first cockpit MCP tool without a CLI twin.

**Question**: Should this spec add corresponding `generacy cockpit gate-open` / `generacy cockpit gate-ack` CLI verbs?

**Options**:
- A: Skip CLI verbs — MCP-tool-only pair; document the exception to design invariant #1 in `server.ts` (spec's stated preference)
- B: Add public CLI verbs — preserves invariant #1 uniformly, at the cost of a barely-usable UX (operators would hand-type a full gate record)
- C: Add hidden/`--internal` CLI verbs — invariant preserved for internal testing/debugging without polluting `--help`

**Answer**: *Pending*

---

### Q4: 4xx error class from orchestrator

**Context**: FR-004 mandates 2xx passes through into `ToolResult.data`. FR-008(d) requires that "4xx from orchestrator surfaced as tool error with the orchestrator's message" — but the spec does not say which `ErrorClass` value. Different 4xx cases have different semantics: 400 = schema mismatch that the tool's own pre-flight validation should have caught (bug), 404 on `/cockpit/gates/:id/ack` = gate id unknown (semantic), 409 = idempotent-conflict variant. The choice affects what `auto.md` matches on to distinguish "retry with a different record" vs. "this is a real problem, escalate".

**Question**: How should the two tools map an orchestrator 4xx response into the `ToolResult` envelope?

**Options**:
- A: All 4xx → `invalid-args` (treat as "the tool's request was wrong"; simplest rule; loses the semantic distinction between 400 and 404/409)
- B: 400 → `invalid-args`; 404 → new `unknown-gate` class (already in `ErrorClass` union at `mcp/errors.ts:18`); 409 → `invalid-args`; other 4xx → `internal`
- C: All 4xx → `internal` (the tool's pre-flight validation should have prevented 4xx entirely, so any 4xx is an unexpected orchestrator/tool disagreement)

**Answer**: *Pending*

---

### Q5: Request timeout — value and configurability

**Context**: Assumption #6 pins the timeout budget at "~5s default" and calls concrete value "an implementation detail". But (i) the exact value governs how snappy `auto.md`'s fallback feels in `--gates=auto` mode, and (ii) whether it's env-configurable affects operability during incidents (e.g. an operator diagnosing a slow orchestrator wants to bump the ceiling without a rebuild). Fastify's default socket keepalive is 5s; the existing `probeControlPlaneSocket` uses 500 ms; the internal-relay-events POST uses no timeout.

**Question**: What timeout should the two tools use for their orchestrator HTTP call, and should it be operator-configurable?

**Options**:
- A: Hardcode 5s in both tools; no env var, no options-bag override (matches Assumption #6 literally; simplest)
- B: `COCKPIT_GATE_TIMEOUT_MS` env override with 5s default (5000); read at request time
- C: Options-bag argument on `startMcp()` with 5s default; no env var (matches Q2 option B if chosen)

**Answer**: *Pending*
