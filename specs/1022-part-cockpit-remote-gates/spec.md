# Feature Specification: cockpit MCP — `cockpit_gate_open` + `cockpit_gate_ack` tools

**Branch**: `1022-part-cockpit-remote-gates` | **Date**: 2026-07-21 | **Status**: Draft

**Tracking issue**: [generacy-ai/generacy#1022](https://github.com/generacy-ai/generacy/issues/1022)
**Epic**: Cockpit Remote Gates (see [cockpit-remote-gates-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md))
**Epic phase**: P1 — Contracts + cluster-side plumbing (child #3 of P1)

## Summary

Add two new MCP verbs to the in-cluster cockpit MCP server so the `/cockpit:auto`
skill can post human gates to the operator inbox on generacy.ai and report per-gate
outcomes, instead of blocking the driving session with `AskUserQuestion`.

Both tools are **thin, in-cluster HTTP clients** over the orchestrator's localhost
gate routes (`POST /cockpit/gates`, `POST /cockpit/gates/:id/ack`, delivered in the
sibling P1.2 issue). This spec covers only the MCP-tool layer: input validation
against the shared gate schemas (P1.1), request dispatch, response envelope, and a
distinct error class that lets `auto.md` fall back to a local `AskUserQuestion`
gate when the tools are unavailable.

## Context and dependencies

The epic replaces the in-session `AskUserQuestion` gate surface with an inbox on
generacy.ai. The up-path (session → cloud) rides two MCP tools:

- **`cockpit_gate_open(gateRecord)`** — the session hands a validated gate record
  (see contracts) to the orchestrator, which re-emits it as a
  `cluster.cockpit` relay event. Cloud upserts the gate doc and streams it into
  the operator inbox.
- **`cockpit_gate_ack({gateId, outcome, detail?})`** — after the session applies
  an inbound answer (via a separate down-path handled by the doorbell / answers
  file, out of scope here), it acks the outcome so cloud can move the inbox
  card into a terminal state.

**Hard blockers, must land first:**

1. **P1.1** — Gate wire contracts in `packages/cockpit/src/gates/` (zod schemas
   for the gate record, answer NDJSON line, outcome ack, plus `gateId` /
   generation derivation). This spec pins to those schemas verbatim.
2. **P1.2** — Orchestrator localhost gate routes (`POST /cockpit/gates`,
   `POST /cockpit/gates/:id/ack`), the `cluster.cockpit` relay channel, and
   retain-and-replay when the relay is disconnected. This spec's tools are
   thin clients of those routes.

**Peers (not blockers):**

- P1.4 (doorbell answers-file tail) delivers answers; unrelated to this spec.
- P4 (auto.md `--gates=ui|local|auto` rework) is the sole consumer of these
  tools. Not shipped here — this spec ships only the primitive.

## User Stories

### US1 — Session posts a gate to the operator inbox (primary)

**As** the `/cockpit:auto` skill running in a cloud-activated cluster,
**I want** to post a fully-formed gate record from within the session,
**So that** an operator can answer it in the generacy.ai inbox while the driving
session keeps dispatching subagent work for other issues.

**Acceptance:**

- `cockpit_gate_open(gateRecord)` validates the input against the shared gate
  schema (from P1.1) and returns `{status: "ok", data: {gateId, status}}` when
  the orchestrator accepts the record.
- Rejects malformed input with `status: "error", class: "invalid-args"` before
  any HTTP call is attempted.
- Re-posting the same logical gate (same `gateId` derived per the P1.1 rules)
  is idempotent from the tool's point of view — it forwards the record and
  surfaces whatever `status` the orchestrator returns.

### US2 — Session acks the outcome once the answer is applied

**As** the `/cockpit:auto` skill after applying (or refusing) an inbound answer,
**I want** to report `applied` / `superseded` / `failed` for the gate,
**So that** the operator's inbox card moves to a terminal state with the
correct outcome and diagnostic detail.

**Acceptance:**

- `cockpit_gate_ack({gateId, outcome, detail?})` validates the input and POSTs
  to the orchestrator's ack route.
- Success returns `{status: "ok", data: {...}}` reflecting the orchestrator's
  ack response.
- Malformed input (missing `gateId`, unknown `outcome` value) returns
  `class: "invalid-args"` without an HTTP call.

### US3 — Skill falls back to a local gate when cloud path is unavailable

**As** the `/cockpit:auto` skill invoked with `--gates=auto`,
**I want** a distinct, matchable error class when the orchestrator is
unreachable or the cluster isn't cloud-activated,
**So that** the skill can transparently fall back to `AskUserQuestion` for that
gate without hanging or crashing.

**Acceptance:**

- Both tools return `class: "transport"` (or a similarly matchable subclass,
  see FR-005) when the orchestrator gate routes are unreachable, timing out,
  or returning 5xx.
- Worker containers already refuse to start the MCP server
  (`GENERACY_CLUSTER_ROLE=worker`, `mcp/index.ts:40`). That refusal is
  preserved unchanged — worker-side skill invocations never reach these
  tools.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Register `cockpit_gate_open` and `cockpit_gate_ack` in the MCP server registry at `packages/generacy/src/cli/commands/cockpit/mcp/server.ts`, alongside the existing thirteen tools. | P1 | Same registration pattern as `cockpit_claim` / `cockpit_release`. |
| FR-002 | Implement the tool handlers as thin HTTP clients under `packages/generacy/src/cli/commands/cockpit/mcp/tools/` — one file per tool (`cockpit_gate_open.ts`, `cockpit_gate_ack.ts`). | P1 | Handlers wrap `wrapToolBoundary` (see `mcp/errors.ts:63`) to guarantee no bare throws reach the transport. |
| FR-003 | Input schemas for both tools are re-exports / thin wrappers over the P1.1 shared gate schemas from `packages/cockpit/src/gates/`. | P1 | This spec does **not** define new field-level shapes; the wire contract owns that. Divergence must be raised on the epic first. |
| FR-004 | On valid input, POST to `${orchestratorBaseUrl}/cockpit/gates` (open) or `${orchestratorBaseUrl}/cockpit/gates/${gateId}/ack` (ack) with JSON body, propagating the orchestrator's response body into `ToolResult.data` on 2xx. | P1 | Orchestrator's exact success payload defined by P1.2; tools pass through whatever it returns. |
| FR-005 | Distinct, matchable error class for the two cloud-path unavailability modes: (a) orchestrator unreachable / network error / 5xx, and (b) cluster not cloud-activated. | P1 | See [NEEDS CLARIFICATION #1](#needs-clarification) on whether one class (`transport`) is sufficient or whether a new class is needed. |
| FR-006 | Orchestrator base URL is discovered via the same mechanism existing in-cluster callers use (env var, defaulted). | P1 | See [NEEDS CLARIFICATION #2](#needs-clarification) — the current cockpit MCP tools don't call the orchestrator; the pattern comes from other cluster-side modules. |
| FR-007 | Preserve worker-role refusal — the `GENERACY_CLUSTER_ROLE=worker` check in `mcp/index.ts` stays as-is; no additional refusal at the tool boundary is needed. | P1 | Verified by not touching `mcp/index.ts`; regression covered by an existing test. |
| FR-008 | Unit tests with a mocked HTTP client cover: (a) happy path returning parsed data, (b) schema-invalid input rejected pre-HTTP, (c) orchestrator unreachable → `transport`-class error, (d) 4xx from orchestrator surfaced as tool error with the orchestrator's message, (e) idempotent re-post accepted. | P1 | Tests colocated under `mcp/__tests__/tools/`, following the pattern of `cockpit_claim.test.ts`. |
| FR-009 | Neither tool touches GitHub, Redis, the answers file, or any other side channel — every action is a single HTTP call to the orchestrator. | P1 | Design invariant #1 (server.ts comment): "Tools call the same internal `run<Verb>()` functions the CLI uses." These two tools are the exception because the "verb" is a single HTTP POST — [NEEDS CLARIFICATION #3](#needs-clarification) on whether a CLI verb should also exist. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Zero divergence between MCP-tool input schema and the shared P1.1 gate schema. | 0 field-level differences | Static import of the shared schema in the tool file — grep for any local re-definition. |
| SC-002 | `/cockpit:auto` in `--gates=auto` mode falls back to a local `AskUserQuestion` gate when `cockpit_gate_open` returns `class: "transport"`. | 100% of transport-class errors trigger fallback | End-to-end test in P4 (out of scope here); this spec ships the fallback surface only. |
| SC-003 | Malformed gate record is rejected before any HTTP call. | 0 HTTP calls on schema-invalid input | Vitest with a mocked fetch — assert `fetch` was never called for a rejected input. |
| SC-004 | Worker-role invocation of the MCP server continues to refuse before any tool is registered. | 100% of worker-mode invocations refuse | Existing regression test in `mcp/__tests__/index.test.ts`. |

## Assumptions

1. The P1.1 gate contracts land first and this spec's schemas import from them
   directly — no local field shapes are defined here.
2. The orchestrator's `POST /cockpit/gates` and `POST /cockpit/gates/:id/ack`
   routes exist by the time this spec is implemented (P1.2 landed).
3. The orchestrator returns JSON (2xx with `{gateId, status}` for open,
   2xx with an ack confirmation for ack; error bodies with a `message` field).
   Exact shapes finalized in P1.2.
4. In-cluster HTTP calls use Node's built-in `fetch` (Node ≥22 is the floor for
   the CLI package); no new HTTP dependency.
5. The tools do not persist state — retry, dedup, and retain-and-replay are the
   orchestrator's responsibility (per the P1.2 spec).
6. Timeout budget for a single orchestrator call is short (~5s default) so a
   hung orchestrator surfaces as `transport` fast enough for the skill's
   fallback path to feel snappy. Concrete timeout value is an implementation
   detail, not a wire contract.

## Out of Scope

- **auto.md skill changes** (P4 — separate issue). This spec ships the MCP
  primitives; the skill's `--gates=ui|local|auto` flag, gate dispatch, and
  supersession validation are all downstream.
- **Orchestrator route implementation** (P1.2 — separate issue). This spec is
  a client of those routes; if they don't exist yet, the tools return
  `transport` errors, which is acceptable behavior.
- **Answers file / doorbell integration** (P1.4). The down-path (answer
  arrival) is unrelated to these tools; a session ack via `cockpit_gate_ack`
  happens strictly after the answer has been applied via the answers-file
  path.
- **Cloud-side gate persistence / SSE / UI** (P2, P3).
- **Retry policy** — the orchestrator's route (P1.2) owns retain-and-replay
  when the relay is disconnected. The tools do a single POST and surface the
  outcome.
- **CLI verb parity** — see [NEEDS CLARIFICATION #3](#needs-clarification); by
  default no CLI verb is added.

## NEEDS CLARIFICATION

1. **Error class for two failure modes**: FR-005 asks for a distinct,
   matchable error class covering both "orchestrator unreachable" and "cluster
   not cloud-activated". Options: (a) reuse existing `transport` for both;
   (b) reuse `transport` for network failures and add a new class
   `cloud-inactive` for the not-activated case; (c) collapse both under a new
   dedicated class (`gate-cloud-unavailable`). The epic doc says only "a
   distinct, matchable error class". Preference: (a) — `transport` is already
   what auto.md would match on and the not-activated case degenerates to
   "orchestrator's `POST /cockpit/gates` returns 5xx / connection refused"
   in practice. Confirm before implementing.

2. **Orchestrator base-URL discovery**: FR-006 says "consistent with existing
   in-cluster callers". The cockpit MCP tools today don't call the
   orchestrator — the pattern would come from other cluster-side modules
   (e.g. control-plane's internal-relay-events forwarder reads
   `ORCHESTRATOR_URL` with a `http://127.0.0.1:3100` default). Confirm the
   env var name and default, and whether it belongs in the MCP `startMcp()`
   options bag or is read at request time inside the tool.

3. **CLI verb parity**: The other twelve cockpit MCP tools all wrap an
   underlying `run<Verb>()` CLI function (design invariant #1 in
   `server.ts`). These two tools have no natural CLI counterpart — they're
   only useful from the driving session and would leak a raw HTTP client if
   exposed as `generacy cockpit gate-open`. Confirm we're OK skipping CLI
   verbs for this pair; if not, we'd need to define UX for hand-invoking a
   remote gate (likely not useful).

---

*Generated by speckit; enhanced by /specify from issue #1022 body and the
[Cockpit Remote Gates epic plan](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md).*
