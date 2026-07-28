# Feature Specification: Add `cluster.cockpit.reply` to `RelayMessageSchema`

**Branch**: `1063-problem-generacy-cloud-887` | **Date**: 2026-07-28 | **Status**: Draft

## Summary

generacy-cloud#887 (merged, live) makes the relay send a `cluster.cockpit.reply`
message back to the cluster for **every** gate frame — the happy path
(`accepted: true`, with a `wroteDoc: 'created' | 'rebound'` discriminator) and
every drop class. The cluster's `RelayMessageSchema`
(`packages/cluster-relay/src/messages.ts:360`) is a `z.discriminatedUnion('type', …)`
of 18 members and does not include `cluster.cockpit.reply`. `parseRelayMessage`
returns `null` for unmatched types, and `relay.ts:293-296` logs the raw payload
as `warn`:

```ts
if (!message) {
  this.logger.warn({ raw: parsed }, 'Invalid relay message, skipping');
  return;
}
```

Net: every *successful* gate ingest now produces a cluster-side WARN carrying
the full reply object. Nothing breaks (satisfies #887's FR-008(b) — the cluster
does not crash or disconnect), but an operator debugging a stuck run sees a
stream of `Invalid relay message, skipping` warnings that are in fact success
acknowledgements. That is actively misleading during exactly the situation the
reply was added to help with.

This is **step 3 of #1059**, split out because it is the one piece safe to land
alone: additive union member, single repo, backward compatible (older cloud
never sends it), immediately valuable (clears misleading warnings on the happy
path).

Explicitly **not in scope**: the `frameId` passthrough and run-scoped gate
identity work — those are #1059 steps 4–7 and must land atomically across three
repos; landing any of them alone silently breaks `cockpit_gate_status`.

## User Stories

### US1: Operator debugging a stuck run stops seeing misleading warnings

**As an** operator inspecting cluster logs during a stuck cockpit gate,
**I want** successful `cluster.cockpit.reply` acknowledgements to not appear as
`Invalid relay message, skipping` warnings,
**So that** the warnings I do see reflect actual problems and are not drowned
by the volume of happy-path acknowledgements.

**Acceptance Criteria**:
- [ ] A `cluster.cockpit.reply` frame with `accepted: true` produces zero
      `warn`-or-above log lines on the cluster.
- [ ] A `cluster.cockpit.reply` frame with `accepted: false` is logged at
      `info` or above, carrying its `reason` field, so genuine drops remain
      visible.

### US2: Cloud can extend the reply shape without re-triggering the bug

**As a** generacy-cloud maintainer,
**I want** to add new optional fields to `ClusterCockpitReplyMessage`,
**So that** future extensions do not reintroduce the drop-and-warn behaviour
this issue exists to remove.

**Acceptance Criteria**:
- [ ] A reply carrying fields not enumerated in the current schema parses
      successfully.
- [ ] A reply carrying an unrecognised `reason` string does not fail parsing.

## Functional Requirements

| ID     | Requirement                                                                                                                                                                                                | Priority | Notes |
|--------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|----------|-------|
| FR-001 | Add a `cluster.cockpit.reply` member to `RelayMessageSchema` in `packages/cluster-relay/src/messages.ts` mirroring cloud's `ClusterCockpitReplyMessage` shape.                                              | P1       | Fields: `type` (literal), `timestamp`, `frameId: string \| null`, `frameType: 'gate-open' \| 'gate-outcome' \| 'unknown'`, `gateId`, `gateKey?`, `accepted: boolean`, `reason?`, `priorStatus?`, `wroteDoc?: 'created' \| 'rebound'`. |
| FR-002 | The new schema is tolerant of unknown fields at the top level (does not reject on extras) and does not enforce a closed enum on `reason`.                                                                    | P1       | Prevents the same drop-and-warn regression on future cloud extensions. |
| FR-003 | The relay message router in `relay.ts` recognises the new message type and does not fall through to the `Invalid relay message, skipping` warn branch.                                                       | P1       | |
| FR-004 | On `accepted: true`, the router logs at `debug` and drops.                                                                                                                                                   | P1       | No downstream consumer; correlation deferred to #1059 steps 4–7. |
| FR-005 | On `accepted: false`, the router logs at `info` (or higher), including `reason`, `frameType`, `gateId`, and `priorStatus` (when present).                                                                    | P1       | Genuine drops must remain operator-visible. |
| FR-006 | No correlation wiring (no `frameId` → in-flight-request map, no promise settlement, no event emit). The message is observability-only in this change.                                                        | P1       | `frameId` is null today per #1059 steps 1–2; wiring lands in #1059 steps 4–7. |
| FR-007 | All 18 pre-existing `RelayMessageSchema` members continue to parse and route exactly as before.                                                                                                              | P1       | Regression guard on the discriminated-union addition. |
| FR-008 | A payload with `type: 'cluster.cockpit.reply'` but a missing required field (e.g. no `gateId`) still fails schema parsing and falls to the existing `Invalid relay message, skipping` warn branch.            | P2       | Bad-payload signalling is preserved. |

## Success Criteria

| ID     | Metric                                                                                              | Target                                    | Measurement                                                                            |
|--------|-----------------------------------------------------------------------------------------------------|-------------------------------------------|----------------------------------------------------------------------------------------|
| SC-001 | Warn-lines produced by a successful gate ingest on the cluster.                                     | 0                                         | Unit test: feed a synthetic `cluster.cockpit.reply { accepted: true }` frame; assert no `warn`-or-above lines on the logger spy. |
| SC-002 | Info-or-above lines produced by an `accepted: false` reply.                                         | ≥ 1, carrying `reason`                    | Unit test: feed a synthetic `accepted: false` frame; assert an `info`-or-above line matches the reason. |
| SC-003 | Tolerance to unknown top-level fields.                                                              | 100% parse success                        | Unit test: feed a `cluster.cockpit.reply` with an extra `futureField: "x"`; assert `parseRelayMessage` returns non-null. |
| SC-004 | Regression on existing message routing.                                                             | All 18 members still parse and route      | Existing relay tests continue to pass unchanged. |

## Assumptions

- The cloud-side `ClusterCockpitReplyMessage` shape is exactly what the issue
  documents (source: `services/api/src/services/relay/relay-types.ts` in
  generacy-cloud, referenced by #887). If cloud has since diverged, the local
  schema stays tolerant enough (per FR-002) that the parse still succeeds.
- No existing consumer expects to receive a `cluster.cockpit.reply` message
  today. Adding a union member is purely additive to the incoming message
  space; no `messageHandler` currently branches on this type.
- Older clusters (pre-fix) will continue to log successful replies as `warn`
  until they upgrade. That is acceptable — the cluster does not crash or
  disconnect, per #887's FR-008(b).
- Older clouds (pre-#887) will not send this message at all, so a
  post-fix cluster on an older cloud sees no change in behaviour. Backward
  compatibility is symmetric.

## Out of Scope

- `frameId` passthrough from the orchestrator (i.e. preserving the id the cloud
  echoes back). Deferred to #1059 step 4.
- Run-scoped gate identity (`gateKey` disambiguation across replays). Deferred
  to #1059 steps 5–7.
- Any correlation between an outbound gate frame and the reply — no
  in-flight-request map, no promise settlement, no `event` emit on `accepted`
  transitions. The reply is purely a log signal in this change.
- Changes to `cockpit_gate_status` behaviour. Landing correlation piecemeal
  across the three repos silently breaks that tool; correlation must land
  atomically in #1059 steps 4–7.
- Metrics/counters on reply outcomes. Log-only in this change.

## Related

- generacy-cloud#887 — the change that started sending these (merged, live).
- #1059 — the remaining cross-repo wiring; this is step 3 extracted.

---

*Generated by speckit*
