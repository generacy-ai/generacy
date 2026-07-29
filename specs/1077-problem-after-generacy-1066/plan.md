# Implementation Plan: Mint a `frameId` per outbound cockpit frame and correlate `cluster.cockpit.reply` back to it

**Feature**: Cluster-side mint + consume for per-frame reply correlation (finishes #1063/#1066)
**Branch**: `1077-problem-after-generacy-1066`
**Status**: Complete
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)

## Summary

#1066 taught the up-path schemas + route to **preserve** a caller-supplied
`frameId`; #1063 taught the relay client to **parse** `cluster.cockpit.reply`.
Neither shipped a **producer** or a **consumer**. This plan wires the two
remaining halves:

1. **Mint** — the orchestrator's `POST /cockpit/gates` and
   `POST /cockpit/gates/:id/ack` handlers (`packages/orchestrator/src/routes/cockpit-gates.ts`)
   mint a `frm_<24-hex>` id at **request-accept time, before `tryEmitOrRetain`**,
   so the 202 echoes the id, a retained frame carries it into the retain queue,
   and drain emits it verbatim. A caller-supplied `frameId` on the request body
   (permitted since #1066) **overrides** the route mint.
2. **Consume** — the relay client (`packages/cluster-relay/src/relay.ts`) owns a
   `Map<frameId, PendingFrame>` populated on **every outbound frame** via a new
   `registerPendingFrame(frameId, meta)` method on `ClusterRelayClient`. The
   `cluster.cockpit.reply` branch at `:334` settles the matching entry (log at
   `info` with `frameId`) or drops with an `info` line naming the unknown
   `frameId`. Entries evict on settle (FR-006) and on 30s TTL (FR-007);
   evictions log at `debug` with `frameId` and age.
3. **Cleanup** — replace the misdirecting `#1059 steps 4-7` comment at
   `relay.ts:330–333` with a pointer to this ticket.

All three land in one PR. No cloud change (`generacy-cloud#890` already echoes
`frameId` from the frame it received; #1066 SC-001 pinned that).

## Technical Context

**Language/Version**: TypeScript, Node.js ≥22 (workspace default; ESM)
**Primary Dependencies**:
- `@generacy-ai/cluster-relay` — WebSocket client owning the pending map
- `@generacy-ai/cockpit` — frozen `GateOpenSchema` / `GateOutcomeSchema` (already
  carry optional `frameId` inside `data`, per #1066)
- `fastify` — orchestrator HTTP framework (routes)
- `zod` — schema validation on both cluster-side wire schemas
- `node:crypto` (`randomBytes`) — id generation; **no new npm dep**
**Storage**: In-memory `Map<string, PendingFrame>` on the ClusterRelay instance.
Process-scoped only — cross-process durability is Out of Scope (see spec).
**Testing**: Vitest across three packages:
- `@generacy-ai/cockpit` — schema tests (no shape change; regression guard)
- `@generacy-ai/orchestrator` — route unit tests + `cockpit-gates-frameid` real-WS
  integration test (extend the fake-peer harness from #1024)
- `@generacy-ai/cluster-relay` — extend `#1063` router-branch tests + new
  pending-map correlation tests
**Target Platform**: Linux (cluster containers) + macOS/Linux dev boxes
**Project Type**: Monorepo — TypeScript packages under `packages/`
**Performance Goals**: Map churn is single-digit at steady state (gate frames are
human-scale; 30s TTL, evict-on-settle). No hot path.
**Constraints**:
- **No behavioural regression on retained frames** — retain path stays a
  byte-for-byte pass-through of `data`; the mint happens **before**
  `tryEmitOrRetain`, so the same object is enqueued and drained.
- **No new caller-observable channel** — decision D2. Correlation is
  observability. Do NOT extend the 202 response with anything more than the
  echoed `frameId`; do NOT add SSE for outcome delivery here; do NOT add
  `GET /cockpit/gates/frames/:frameId`.
- **Structural short-circuit at `cluster.cockpit.reply` preserved** — the FR-003
  test at `relay.test.ts:830` pins that registered `onMessage` handlers do NOT
  see reply frames. The new pending logic replaces the log-and-return but stays
  before that dispatch.
- **`grep -rn 'frameId' packages/generacy/src | wc -l` returns non-zero** —
  SC-006. The two MCP tool wire schemas (`GateOpenWireSchema`,
  `GateOutcomeWireSchema`) grow an optional `frameId` field so a future caller
  that pre-generates one for its own logging can supply it without a shape mismatch.
**Scale/Scope**: 3 packages touched; ~7 code files; ~5 test files. One integration
test needs the real-WS fixture from #1024.

## Constitution Check

No `.specify/memory/constitution.md` in this repo. Standing project rules from
`CLAUDE.md` that apply:

- **Changeset required** — `packages/{cluster-relay,orchestrator,generacy,cockpit}/src/`
  all get non-test edits. Add `.changeset/1077-frameId-mint-consume.md` bumping
  `@generacy-ai/cluster-relay` **minor** (new public method
  `registerPendingFrame`), `@generacy-ai/orchestrator` **patch** (internal route
  behaviour), `@generacy-ai/generacy` **patch** (optional wire-schema field), and
  `@generacy-ai/cockpit` — **no change** (schema already carries `frameId` since
  #1066; regression tests only, no bump).
- **No comments narrating what the code does** — the new pending map does not
  get a docstring inventorying its methods. Only the load-bearing comment update
  at `relay.ts:330–333` (FR-009) has narrative — because a wrong pointer is what
  caused this gap in the first place.
- **No premature abstraction** — the pending map is a `Map`, not a class with
  hooks/observers. If a future consumer needs the outcome in-band, decision D2
  says that's a follow-up SSE event, not a hook here.

## Project Structure

### Documentation (this feature)

```text
specs/1077-problem-after-generacy-1066/
├── plan.md              # This file
├── spec.md              # Read-only — feature specification
├── clarifications.md    # Read-only — resolved design decisions
├── research.md          # Technology decisions with rationale
├── data-model.md        # PendingFrame + wire-shape types
├── quickstart.md        # How to exercise the fix locally
├── contracts/
│   ├── mint-route.md            # Route-side mint contract (D1)
│   ├── pending-map.md           # ClusterRelay pending-map contract (D2/D5)
│   └── wire-response.md         # 202 response body (frameId echo)
└── tasks.md             # (Phase 2 output — /speckit:tasks, not this command)
```

### Source Code (repository root)

Files edited in this feature (all under `packages/`):

```text
packages/orchestrator/
├── src/routes/cockpit-gates.ts                              # MINT: both handlers
├── src/routes/__tests__/cockpit-gates.test.ts               # unit: mint + echo + override
└── src/__tests__/cockpit-gates-frameid.integration.test.ts  # extend: real-WS settle

packages/cluster-relay/
├── src/relay.ts                                             # CONSUME: pending map + settle
│                                                            # CLEANUP: comment at :330–333
└── tests/relay.test.ts                                      # extend #1063 branch tests
                                                             #   + new pending-map tests

packages/generacy/
├── src/cli/commands/cockpit/mcp/gates/schemas.ts            # optional frameId on wire schemas
└── src/cli/commands/cockpit/mcp/gates/__tests__/            # schema regression
    schemas.test.ts (or existing tests)

packages/cockpit/
└── (no code change — GateOpenSchema/GateOutcomeSchema already accept frameId
   optionally per #1066. Only add a wire-fixture-with-frameId cross-test if a
   parity gap surfaces during implementation.)

.changeset/
└── 1077-frameId-mint-consume.md                             # cluster-relay minor
                                                             #   + orchestrator patch
                                                             #   + generacy patch
```

**Structure Decision**: Monorepo. The mint site (D1) and pending map (D2) sit in
**different packages** by design — `packages/orchestrator/src/routes/cockpit-gates.ts`
holds the mint (colocated with `tryEmitOrRetain`), and
`packages/cluster-relay/src/relay.ts` holds the pending map (colocated with the
`cluster.cockpit.reply` receive branch and the `send()` outgoing channel).
Wiring is a single new method on the `ClusterRelayClient` interface
(`registerPendingFrame`) — the route calls it after mint. No new package, no new
module. Preserves the process boundary invariants documented in clarifications
(sender + receiver live in different processes; but the route and the reply
handler live in the **same** orchestrator process, so the pending map is a
single-process affair).

## Complexity Tracking

No constitution violations to justify. Deliberately not building:

| Not building | Why | Trade-off accepted |
|---|---|---|
| `waitFor(frameId, timeoutMs)` promise API on `ClusterRelay` | D2 — no in-process caller today; adding it turns fire-and-forget sends into synchronous cloud round-trips at the startup sweep. | Sender does not learn outcome. Logged instead. |
| `GET /cockpit/gates/frames/:frameId` polling endpoint | D2 — builds a delivery channel for a consumer that does not exist. | Same. Follow-up SSE if a consumer surfaces. |
| SSE event for frame outcomes | D2 — same, plus retention/auth surface. | Same. |
| Per-call TTL knob | Q3 — no evidence to tune; a knob without a caller is dead code. | 30s fixed; `debug` eviction log makes retuning data-driven. |
| Sticky pending-map metrics (Prometheus / etc.) | Out of scope; observability today is `info` on settle + `debug` on TTL. | Follow-up if operators need a gauge. |
| Cross-process durability of the pending map | Assumption in spec. Doomed caller's reply hits quiet-drop; observability records it. | Correctness bounded by process lifetime. |
