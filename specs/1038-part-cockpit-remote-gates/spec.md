# Feature Specification: Cockpit gates — read-only gate-status query + stable sweep generation derivation

**Branch**: `1038-part-cockpit-remote-gates` | **Date**: 2026-07-24 | **Status**: Draft | **Issue**: [#1038](https://github.com/generacy-ai/generacy/issues/1038)

## Summary

Part of the **Cockpit Remote Gates** epic (generacy-ai/generacy-cloud#850) — dogfood follow-up from the `--gates=ui` run tracked in generacy-ai/agency#450. Design + wire contracts: [docs/cockpit-remote-gates-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md).

This is the cluster-side dependency of the agency sweep fix. The `--gates=ui` startup sweep currently re-drafts and re-opens gates that are already pending because (a) there is no cheap way to ask *"is a gate already open for this issue + type?"* before running the drafting subagent, and (b) sweep-derived `gateId`s don't match live-derived ones, so a cloud upsert can't coalesce them into a single inbox row.

## Problem 1 — no gate-status query

`cockpit_gate_open` cannot serve as an existence check:

- Its input requires the fully-drafted `title`/`body`/`options` (`GateOpenInputSchema`, `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:84-107`) — i.e. the drafting subagent must have already run.
- Its output `{ gateId, status }` carries only `retained` (relay down) or `open` (emitted), derived from the relay envelope — **not** from cloud gate state (`.../mcp/tools/cockpit_gate_open.ts:107-114`). No `answered`/`already-exists` signal.
- Documented **"Not idempotent"** (`specs/1022-part-cockpit-remote-gates/contracts/cockpit_gate_open.md:106-111`).
- Orchestrator route is fire-and-forget with no lookup (`packages/orchestrator/src/routes/cockpit-gates.ts:86-126`).
- There is no `GET` route and no `cockpit_gate_status`/`cockpit_gate_list` tool — `mcp/server.ts` registers only `cockpit_gate_open` (`:205`) and `cockpit_gate_ack` (`:216`).

**Direction of fix:** add a read-only query — a `GET /cockpit/gates?issueRef=&gateType=` (or by `gateId` prefix) orchestrator route + a thin `cockpit_gate_status` / `cockpit_gate_list` MCP tool — returning `{ gateId, status: open | answered | absent }` **without** requiring a drafted body. Cloud (Firestore) is the source of truth; whether the orchestrator proxies the query over the relay (same path answers ride) or cloud exposes it directly is a plan-phase decision.

## Problem 2 — sweep generation derivation is unstable, so gateIds don't coalesce

Even with a query, the sweep and live paths derive **different** `gateId`s for the same natural gate, so a cloud upsert can't coalesce them:

- The sweep hard-codes `generation=1` (`packages/claude-plugin-cockpit/commands/auto.md:198` in agency), contradicting the per-`gateType` content-derived discriminator the live path uses (e.g. clarification generation = content hash of the answer set, `auto.md:1356-1358`).
- The durable `generation` discriminator is **not computed today** for `clarification` (no answer-set hash), `artifact-review`/`implementation-review` + `manual-validation` (no head SHA), and `escalation` (no occurrence counter) — the DATA GAPS at `auto.md:1367`. Until derived from durable GitHub state, re-asks across restart/takeover aren't idempotent for those gate types.

`gateId = sha256("<issueRef>:<gateType>:<generation>")[:24]` (`schemas.ts:67-77`), so a stable, durable-GitHub-derived `generation` is required for the same gate to hash identically across sessions. This repo owns `deriveGateKey`/`deriveGateId` and the per-gate-type generation rules — reconcile them so the Problem 1 query returns a match. (The corresponding `generation=1` sweep default is fixed on the agency side.)

## User Stories

### US1 (P1) — Sweep skips already-open gates without drafting

**As** the `--gates=ui` startup sweep in `/cockpit:auto`,
**I want** a cheap "is a gate of this type already pending for this issue?" query I can call **before** running the drafting subagent,
**So that** I skip already-answered / already-pending gates and stop producing duplicate inbox rows on restart or takeover.

**Acceptance criteria**:
- [ ] Given a natural gate `(issueRef, gateType)` is `open` or `answered` in cloud, when the sweep queries status, the response is `open` or `answered` respectively and the drafting subagent is not invoked.
- [ ] Given no gate exists, the response is `absent` and the sweep proceeds with normal drafting + `cockpit_gate_open`.
- [ ] The query does **not** require `title`, `body`, or `options` in the request.

### US2 (P1) — Restart-safe gate identity

**As** the cockpit MCP server on either a fresh session or a takeover,
**I want** `deriveGateId(issueRef, gateType, ...)` to produce the same 24-char id as any earlier session did for the same natural gate,
**So that** cloud can upsert answers onto the original inbox row instead of stranding a re-opened duplicate.

**Acceptance criteria**:
- [ ] For `clarification`, `generation` is derived from a stable durable-GitHub-state input (answer-set / clarification-round hash) — never `1`.
- [ ] For `implementation-review`, `generation` is derived from the head SHA of the PR under review — never `1`.
- [ ] A gate re-derived by the startup sweep hashes to the same `gateId` as the live path's original open.

### US3 (P2) — Observable state for the operator

**As** a cockpit operator investigating a stuck gate,
**I want** to list all open gates for an issue via MCP,
**So that** I can see what the auto-loop is waiting on without inspecting cloud Firestore directly.

**Acceptance criteria**:
- [ ] `cockpit_gate_list` returns all non-`absent` gates for a given `issueRef` with `{ gateId, gateType, status }`.
- [ ] Empty list when no gates exist (does not throw).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Expose a read-only query returning `{ gateId, status: 'open' \| 'answered' \| 'absent' }` for a natural gate identity `(issueRef, gateType[, generation])`. | P1 | Whether by `gateId` prefix or `(issueRef, gateType)` composite is a plan-phase decision. |
| FR-002 | Query MUST NOT require the drafted `title`/`body`/`options` payload. | P1 | The whole point — cheaper than drafting. |
| FR-003 | Add MCP tool `cockpit_gate_status` (single-gate lookup) registered in `mcp/server.ts`. | P1 | Sibling of `cockpit_gate_open` / `cockpit_gate_ack`. |
| FR-004 | Add MCP tool `cockpit_gate_list` (all gates for an `issueRef`) registered in `mcp/server.ts`. | P2 | US3. |
| FR-005 | Add orchestrator route `GET /cockpit/gates` (query params `issueRef`, optional `gateType`, optional `gateId`). | P1 | Sibling of the existing POST at `packages/orchestrator/src/routes/cockpit-gates.ts`. |
| FR-006 | Source of truth for `status` is cloud (Firestore); orchestrator either proxies via relay (same channel answers ride on) or cloud exposes the query directly. | P1 | Plan-phase decides transport. |
| FR-007 | Compute a durable, GitHub-state-derived `generation` for `clarification` gates (e.g. content hash of the open-clarification set on the issue). | P1 | Replaces both `1` (sweep) and any live per-session hash. |
| FR-008 | Compute a durable, GitHub-state-derived `generation` for `implementation-review` gates (e.g. head SHA of the PR under review). | P1 | Load-bearing for the epic's PR review re-hit flow. |
| FR-009 | `deriveGateId` output MUST be identical for the sweep path and the live path given the same natural gate. | P1 | Regression test asserts hash equality. |
| FR-010 | Contracts, schema docs (`specs/1022-part-cockpit-remote-gates/contracts/`), and a changeset are updated to reflect the new tool + route + generation rules. | P1 | Per CLAUDE.md gate. |
| FR-011 | Query failures (relay down, cloud unreachable) return a distinct error class the sweep can distinguish from `absent` — sweep MUST NOT treat "cloud unreachable" as "no gate exists". | P1 | Prevents duplicate-inbox-row regression when cloud is degraded. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Duplicate inbox rows produced per `--gates=ui` restart against a scope with N already-pending gates | 0 | Manual: run agency's `/cockpit:auto --gates=ui`, restart mid-flight, count Firestore rows per `(issueRef, gateType)`. |
| SC-002 | `gateId` equality between sweep-derived and live-derived paths for `clarification` and `implementation-review` | 100% | Vitest: fixture-based test in `packages/generacy/src/cli/commands/cockpit/mcp/gates/__tests__/` covering both paths. |
| SC-003 | Drafting subagent invocations avoided per already-pending gate on sweep | 1-per-gate → 0 | Manual: count subagent spawns during a re-run against a fully-pending scope. |
| SC-004 | New tools appear in MCP tool list from `/mcp` slash command | Both `cockpit_gate_status` and `cockpit_gate_list` present | Manual: run `/mcp` in Claude Code, inspect tool list. |
| SC-005 | Contract docs updated | New `contracts/cockpit_gate_status.md`, `contracts/cockpit_gate_list.md`, `contracts/get-cockpit-gates.md` present under `specs/1038-*/contracts/` | File presence in PR diff. |

## Assumptions

- Cloud (Firestore) already stores gate state with a queryable shape; if not, generacy-cloud sibling scope covers exposing it (out of scope here).
- Existing `RelayMessageSchema` supports request/response envelopes for a status query, or a new envelope type is a load-bearing plan-phase addition.
- The wire path for the status query is the **same** relay as `cockpit_gate_open` / answers ride on (single transport, single degraded-mode story).
- `clarification` generation derived from the current open-clarification-set on the issue is durable enough across restarts for our use case; deeper "round" semantics can iterate later.
- Auto-mode single-driver claim (#1015) is orthogonal — this issue's stability guarantee is per-natural-gate, not per-driver.

## Out of Scope

- Fixing the sweep-side hard-coded `generation=1` in `packages/claude-plugin-cockpit/commands/auto.md` — that lives in the `generacy-ai/agency` repo (linked issue).
- Generation derivation for `artifact-review`, `manual-validation`, `escalation`, `phase-queue`, `filing`, `scope-drained` — these DATA GAPS are tracked separately; this issue narrows to the two gate types that materially block the sweep.
- Firestore-side query implementation (generacy-cloud sibling).
- A UI-side "list open gates" view — separate cloud-app scope.
- Migrating pre-existing `generation=1` inbox rows in Firestore — the coalescing target is *future* opens, not backfill.

---

*Generated by speckit*
