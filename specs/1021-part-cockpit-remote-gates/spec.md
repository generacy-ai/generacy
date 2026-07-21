# Feature Specification: Cockpit gate routes, cluster.cockpit relay channel, answers-file writer

**Branch**: `1021-part-cockpit-remote-gates` | **Date**: 2026-07-21 | **Status**: Draft
**Issue**: [generacy-ai/generacy#1021](https://github.com/generacy-ai/generacy/issues/1021)
**Design doc**: [cockpit-remote-gates-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md)
**Epic**: Cockpit Remote Gates (tracked in `generacy-ai/generacy-cloud`)

## Summary

Cluster-side plumbing for the Cockpit Remote Gates operator inbox: the orchestrator
gains three localhost/relay routes (`POST /cockpit/gates`, `POST /cockpit/gates/:id/ack`,
`POST /cockpit/answers`), a new allow-listed `cluster.cockpit` relay-event channel with
retain-and-replay across disconnects, and an append-only NDJSON answers file at
`/workspaces/.generacy/cockpit/answers.ndjson`. This is Phase 1 (P1) of the epic — the
substrate the MCP `cockpit_gate_open` / `cockpit_gate_ack` tools, the doorbell answers-
file tail, and the cloud-side gates collection all depend on.

Wire contracts are frozen in the design doc. This issue implements them as written; any
contract change ships as an amendment on the epic first.

## Context

`/cockpit:auto` today surfaces every human gate as an in-session `AskUserQuestion`,
which blocks the driving conversation while other issues' doorbell events pile up. The
Remote Gates epic moves gate answering to a central operator inbox on generacy.ai so
the session keeps dispatching. Answers must ride the API-key-authenticated relay
WebSocket in both directions — the unauthenticated smee.io channel is never used for
gate content or answers (anyone with the smee URL could otherwise inject an "approve
merge").

The orchestrator is the cluster-side hub: the in-session cockpit MCP server posts gates
to it over localhost; generacy-cloud pushes answers down to it as relay-proxied
`api_request`s. This spec covers only the orchestrator's half — the MCP tools that
call these routes (Phase 1 issue #3), the doorbell that tails the answers file
(Phase 1 issue #4), and the cloud side (Phase 2/3) are separate work.

The `cluster.cockpit` channel joins the five existing allow-listed channels in
`packages/orchestrator/src/routes/internal-relay-events.ts` (`cluster.vscode-tunnel`,
`cluster.audit`, `cluster.credentials`, `cluster.bootstrap`, `cluster.identity-split`).
Retain-and-replay follows the `cluster.vscode-tunnel` pattern in `retained-tunnel-event.ts`
— events emitted while the relay is disconnected are held in-memory and re-sent on
handshake so the cloud never misses a gate open/ack. The answers-file location mirrors
the smee-channel workspace mirror (`/workspaces/.generacy/cockpit/smee-channel`),
placing operator answers where in-workspace consumers (the doorbell subprocess) can tail
them.

## User Stories

### US1 — Driving session posts a gate without blocking

**As** the cockpit MCP server running inside a `/cockpit:auto` session,
**I want** to POST a gate record to `/cockpit/gates` on the orchestrator and get an
immediate 2xx back,
**So that** the session can register the gate with the cloud inbox and return to its
dispatch loop instead of blocking on `AskUserQuestion`.

**Acceptance**:
- [ ] `POST /cockpit/gates` with a valid `GateRecord` returns 2xx synchronously and
  emits a `cluster.cockpit` relay event carrying the record.
- [ ] `POST /cockpit/gates/:id/ack` with a valid `GateOutcomeAck` returns 2xx and
  emits a `cluster.cockpit` outcome event.
- [ ] Malformed payloads return 400 with a structured log line; no relay event is
  emitted.

### US2 — Cloud pushes an answer down and the session sees it exactly once

**As** generacy-cloud (via the authenticated relay `api_request` transport),
**I want** to POST a `GateAnswer` to `/cockpit/answers` on the target cluster's
orchestrator,
**So that** the answer lands in the workspace answers file where the doorbell tail
picks it up and re-injects it into the session — even if the same answer is delivered
twice.

**Acceptance**:
- [ ] Valid `GateAnswer` returns 2xx and appends exactly one NDJSON line to
  `/workspaces/.generacy/cockpit/answers.ndjson` (parent dir created if missing, mode
  0644).
- [ ] Second delivery with the same `deliveryId` returns 2xx but writes nothing.
- [ ] Invalid `GateAnswer` returns 400 with structured log; the file is untouched.

### US3 — Gate events survive a relay disconnect

**As** the operator watching the generacy.ai inbox,
**I want** gate open/ack events emitted during a relay outage to arrive at the cloud as
soon as the cluster reconnects,
**So that** I never miss a gate because the WebSocket briefly dropped.

**Acceptance**:
- [ ] Emitting a `cluster.cockpit` event while `relay.isConnected === false` retains
  it in-memory (same pattern as `cluster.vscode-tunnel`).
- [ ] On the next successful relay handshake, retained events are re-sent in order
  before any new event on the channel.

## Functional Requirements

| ID     | Requirement                                                                                                                                                       | Priority | Notes |
|--------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|-------|
| FR-001 | Register `POST /cockpit/gates` on the orchestrator's public Fastify instance (localhost-callable by the in-cluster MCP server; no auth beyond the socket boundary). | P1       | Body: `GateRecord` from `packages/cockpit/src/gates/`. |
| FR-002 | Register `POST /cockpit/gates/:id/ack`; body validated as `GateOutcomeAck`; `:id` must match `body.gateId`.                                                       | P1       | Mismatch → 400. |
| FR-003 | Register `POST /cockpit/answers` reachable via the relay `api_request` path prefix; body validated as `GateAnswer`.                                                | P1       | Cloud dispatches via `RequestRouter.routeRequest`. |
| FR-004 | Extend `ALLOWED_CHANNELS` in `routes/internal-relay-events.ts` to include `cluster.cockpit`.                                                                       | P1       | Gates and acks emit through this channel. |
| FR-005 | Retain-and-replay for `cluster.cockpit` when `relay.isConnected === false`, following the `cluster.vscode-tunnel` pattern in `retained-tunnel-event.ts`.           | P1       | Preserve emission order; re-send on handshake. |
| FR-006 | Import + reuse the `GateRecord`, `GateOutcomeAck`, and `GateAnswer` zod schemas from `packages/cockpit/src/gates/` (Phase 1 issue #1's contracts module).           | P1       | Do not redeclare shapes. Depends on the contracts issue landing first. |
| FR-007 | `POST /cockpit/answers` deduplicates by `deliveryId`; second delivery of the same id returns 2xx and writes nothing.                                              | P1       | Dedup state may be persisted alongside the answers file to survive orchestrator restarts. |
| FR-008 | Answers file path is `/workspaces/.generacy/cockpit/answers.ndjson`, mode 0644, append-only. Parent directory created on first write.                              | P1       | Matches the smee-channel workspace mirror. |
| FR-009 | Each answer is written as exactly one NDJSON line, atomically (no partially written lines even under crash or concurrent writes).                                  | P1       | Serialize writes; write full line + `\n` in one syscall (or via a mutex). |
| FR-010 | Size-capped rotation: when the file exceeds a configured threshold, rotate to a numbered sibling (e.g. `answers.ndjson.1`); tailing consumers must tolerate rotation. | P1       | Rotation covered by tests. |
| FR-011 | Malformed payloads on any of the three routes return HTTP 400 with a structured `pino` warn/error log; nothing is written or emitted.                             | P1       | No partially applied side effects. |
| FR-012 | On successful gate open/ack, the emitted relay event uses the `{ type: 'event', event: 'cluster.cockpit', data: <payload>, timestamp }` wire shape (as fixed in #600). | P1       | Same envelope as other `cluster.*` channels. |
| FR-013 | The answers file must never contain secrets; malformed input never reaches the file (validated first).                                                            | P1       | Defense in depth for the workspace-visible mirror. |
| FR-014 | Retained-event storage bounds memory: cap retained-event count/bytes and drop-oldest with a warn log when exceeded.                                               | P2       | Prevents unbounded growth if the relay stays down for hours. |

## Success Criteria

| ID     | Metric                                                                                                                       | Target                                | Measurement |
|--------|-------------------------------------------------------------------------------------------------------------------------------|---------------------------------------|-------------|
| SC-001 | Gate open observed as a `cluster.cockpit` event on the relay after `POST /cockpit/gates` returns 2xx.                         | 100 %                                 | Integration test with a fake relay peer. |
| SC-002 | Gate ack observed as a `cluster.cockpit` event on the relay after `POST /cockpit/gates/:id/ack` returns 2xx.                  | 100 %                                 | Integration test. |
| SC-003 | Gate open/ack emitted during a relay outage arrive at the fake peer in order after reconnect.                                | 100 %                                 | Integration test toggling `relay.isConnected`. |
| SC-004 | Duplicate `deliveryId` on `POST /cockpit/answers` appends exactly one NDJSON line total.                                     | 100 % (0 double-appends across N=1000 duplicates) | Unit + integration test. |
| SC-005 | Answers file rotates when the size cap is crossed and the tail resumes on the new file without dropping in-flight answers.   | 0 drops in the rotation test          | Rotation-specific test. |
| SC-006 | Invalid `GateRecord` / `GateOutcomeAck` / `GateAnswer` payload returns 400, produces a structured log line, and leaves the answers file and retained-event store untouched. | 100 %              | Table-driven negative tests. |
| SC-007 | Zero cross-package leakage: gate schemas live in `packages/cockpit/src/gates/` and are imported by the orchestrator (no local re-declarations). | 100 %                | Grep test in CI. |

## Assumptions

- The `packages/cockpit/src/gates/` contracts module (Phase 1 issue #1) lands before or
  alongside this issue; the orchestrator imports its zod schemas rather than
  re-declaring shapes.
- The `POST /cockpit/answers` route is reachable via the existing relay path-prefix
  dispatcher pattern (same mechanism as `/control-plane/*` per #574 and
  `/code-server/*` per #586). If a new prefix is required, orchestrator's
  `initializeRelayBridge()` adds a `{ prefix: '/cockpit', target: '...' }` route
  entry.
- The answers file's parent (`/workspaces/.generacy/cockpit/`) may not exist on first
  boot; the writer creates it with the same permissions strategy as the smee-channel
  mirror.
- Retain-and-replay for `cluster.cockpit` uses the same in-memory pattern as
  `cluster.vscode-tunnel` (module-scoped state, no persistence across orchestrator
  restart). Cross-restart durability is provided by the cloud re-delivering answers
  on cluster handshake (out of scope here, handled Phase 2).
- The orchestrator process itself is authoritative for `deliveryId` dedup within a
  single run; cross-restart dedup is provided by the append-only file (readers skip
  already-processed lines by `deliveryId`).
- Rotation threshold is configurable via env var with a sensible default (e.g. 10 MB).

## Out of Scope

- **MCP tools** `cockpit_gate_open` / `cockpit_gate_ack` — separate Phase 1 issue #3.
- **Doorbell answers-file tail** and event-bus feed — separate Phase 1 issue #4.
- **Cloud-side** gates Firestore collection, SSE stream, REST endpoints, respond
  route, `RequestRouter` delivery, context endpoint, inbox UI — Phase 2/3.
- **agency `auto.md` rework** (`--gates=ui`, D.12 dispatch, supersession validation) —
  Phase 4.
- **Gate schemas themselves** — Phase 1 issue #1 (`packages/cockpit/src/gates/`); this
  issue only *consumes* them.
- Any change to the smee-channel or doorbell paths beyond adding the new answers-file
  mirror.

## References

- Design doc: [cockpit-remote-gates-plan.md](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md) — authoritative wire contracts (§ Wire contracts) and phase ordering (§ Epic structure).
- Retain-and-replay reference: `packages/orchestrator/src/routes/retained-tunnel-event.ts` and the `cluster.vscode-tunnel` branch in `routes/internal-relay-events.ts:54-64`.
- Allow-list extension point: `packages/orchestrator/src/routes/internal-relay-events.ts:9-15`.
- Relay path-prefix dispatcher pattern: `packages/cluster-relay/src/dispatcher.ts` (introduced #489), plus `initializeRelayBridge()` route registration in `packages/orchestrator/src/server.ts` (#574, #586).
- Event wire-shape (fixed in #600): `{ type: 'event', event, data, timestamp }`.

---

*Generated by speckit*
