# Implementation Plan: Add `cluster.cockpit.reply` to `RelayMessageSchema`

**Feature**: Add a `cluster.cockpit.reply` member to `RelayMessageSchema` so cloud-sent gate acknowledgements stop appearing as `Invalid relay message, skipping` warns
**Branch**: `1063-problem-generacy-cloud-887`
**Status**: Complete

## Summary

Cloud's #887 (merged, live) sends a `cluster.cockpit.reply` message for every gate
frame — the happy path (`accepted: true`) and every drop class. The cluster's
`RelayMessageSchema` at `packages/cluster-relay/src/messages.ts:360` is a
`z.discriminatedUnion('type', …)` with 18 members and does not include this
type. `parseRelayMessage` at `messages.ts:387-390` returns `null`, and the router
at `relay.ts:292-296` logs `warn: 'Invalid relay message, skipping'` with the
raw payload attached.

Fix: add a 19th union member (`ClusterCockpitReplyMessageSchema`) with the
minimum-tolerance shape from clarifications (Q1=A `.passthrough()`, Q2=A open
`z.string()` on `frameType`/`wroteDoc`/`reason`, closed literals only where
they discriminate the message itself), and add a short-circuit branch in
`relay.ts` before the `messageHandlers` fanout (Q3=A) that logs and returns
(Q4=C: full parsed object at `debug` on `accepted: true`; enumerated fields
at `info` on `accepted: false`).

**Not in scope**: `frameId` correlation, promise settlement, in-flight-request
map, `cockpit_gate_status` behaviour changes. Those land atomically in #1059
steps 4–7. This change is observability-only.

## Technical Context

**Language / runtime**: TypeScript, Node.js ≥20 (per `packages/cluster-relay`
`engines`). ESM.

**Dependencies (unchanged)**: `zod` (already a direct dep of
`@generacy-ai/cluster-relay`), `ws`, `pino`. No new dependencies.

**Test framework**: Vitest (existing tests at
`packages/cluster-relay/tests/messages.test.ts` and `tests/relay.test.ts`).

**Package surface**:
- `packages/cluster-relay` — single package touched.
- Exports a new interface `ClusterCockpitReplyMessage` from `messages.ts`
  alongside the other 18 message interfaces. Additive.

**Backward compatibility**: symmetric.
- Older clusters on new cloud: continue to log `warn` per current behaviour
  (per spec Assumptions §3, acceptable — cluster does not crash or disconnect,
  satisfies #887's FR-008(b)).
- Older clouds on new cluster: no `cluster.cockpit.reply` frames sent, zero
  behaviour change on the cluster.

## Project Structure

```
packages/cluster-relay/
├── src/
│   ├── messages.ts                       # MODIFIED: add interface + schema + union member
│   └── relay.ts                          # MODIFIED: add short-circuit branch before messageHandlers fanout
└── tests/
    ├── messages.test.ts                  # MODIFIED: parse cases (accepted true/false, passthrough, missing gateId)
    └── relay.test.ts                     # MODIFIED: router log-level cases (SC-001, SC-002)

specs/1063-problem-generacy-cloud-887/
├── spec.md                               # read-only input
├── clarifications.md                     # read-only input
├── plan.md                               # THIS FILE
├── research.md                           # sibling artifact
├── data-model.md                         # sibling artifact
├── quickstart.md                         # sibling artifact
└── contracts/
    └── cluster-cockpit-reply.schema.json # JSON Schema mirror for cross-repo reference

.changeset/
└── 1063-cluster-cockpit-reply.md         # NEW: @generacy-ai/cluster-relay minor
```

## Files Modified

### `packages/cluster-relay/src/messages.ts` (MODIFIED)

Three additions, all after the existing `TierInfoMessageSchema` block and
before `RelayMessageSchema`:

1. **Interface** `ClusterCockpitReplyMessage` next to the other 18 interfaces
   at the top of the file (around line 149 after `TierInfoMessage`). Fields
   per FR-001 with Q2=A widening on `frameType`, `wroteDoc`, `reason`.

2. **Schema** `ClusterCockpitReplyMessageSchema` — a `z.object({ ... }).passthrough()`
   with `type: z.literal('cluster.cockpit.reply')`. Currently-known values for
   `frameType` (`'gate-open' | 'gate-outcome' | 'unknown'`) and `wroteDoc`
   (`'created' | 'rebound'`) documented in a code comment above the schema; not
   enforced (Q2=A).

3. **Union member** — append `ClusterCockpitReplyMessageSchema` as the 19th
   entry in `RelayMessageSchema` at `messages.ts:360`. Append to the end (not
   inserted mid-list) to keep the diff clean; discriminated-union entry order
   is not semantically meaningful.

4. **Type union** — extend the `RelayMessage` union type at
   `messages.ts:151-169` to include `ClusterCockpitReplyMessage`.

### `packages/cluster-relay/src/relay.ts` (MODIFIED)

Insert a new branch inside `ws.on('message', ...)` **after** the existing
`api_request` short-circuit at `relay.ts:315-322` and **before** the
`messageHandlers` fanout at `:324-331`. Structure:

```ts
if (message.type === 'cluster.cockpit.reply') {
  if (message.accepted) {
    this.logger.debug({ message }, 'cluster.cockpit.reply received');
  } else {
    this.logger.info(
      {
        reason: message.reason,
        frameType: message.frameType,
        gateId: message.gateId,
        priorStatus: message.priorStatus,
      },
      'cluster.cockpit.reply dropped',
    );
  }
  return;
}
```

Placement note: the branch must be positioned **after** the two
`authenticating → connected` transitions at `relay.ts:298-313` so that a reply
message received during the auth window still promotes the state. (Same
reasoning as `api_request`.)

### `packages/cluster-relay/tests/messages.test.ts` (MODIFIED)

Add cases:
- Parses a valid `cluster.cockpit.reply` with `accepted: true` and `wroteDoc: 'created'`.
- Parses a valid `cluster.cockpit.reply` with `accepted: false` and `reason: 'schema-invalid'`.
- Preserves an unknown top-level field (`futureField: 'x'`) — SC-003.
- Accepts an unrecognised `reason` string, `frameType`, and `wroteDoc` value — Q2=A.
- Returns `null` when `gateId` is missing (FR-008) — bad-payload signalling preserved.

### `packages/cluster-relay/tests/relay.test.ts` (MODIFIED)

Add cases using the existing WebSocketServer test harness pattern:
- SC-001: `accepted: true` frame → assert no `warn`-or-above log lines on the pino spy.
- SC-002: `accepted: false` frame → assert one `info`-or-above line matching the reason.
- Regression: registered message handlers **do not** see the reply (Q3=A short-circuit assertion).

### `.changeset/1063-cluster-cockpit-reply.md` (NEW)

Content:

```md
---
'@generacy-ai/cluster-relay': minor
---

Add `cluster.cockpit.reply` member to `RelayMessageSchema` so cloud-sent gate
acknowledgements stop appearing as `Invalid relay message, skipping` warns.
Observability-only; correlation deferred to #1059 steps 4–7.
```

**Bump level rationale**: `minor` per CLAUDE.md's Changesets rule ("new
capability → `minor`") — a new discriminated-union member is a new
public wire-shape.

## Test Strategy

**Unit-only.** No integration harness required. All acceptance criteria
resolve against the existing `parseRelayMessage` + `ClusterRelay.ws.on('message')`
seams. No WebSocket, no cloud interaction, no filesystem, no timers.

Coverage per SC:
- **SC-001** — `tests/relay.test.ts` new case.
- **SC-002** — `tests/relay.test.ts` new case.
- **SC-003** — `tests/messages.test.ts` passthrough case.
- **SC-004** — existing test suites (`messages.test.ts`, `relay.test.ts`)
  continue to pass unchanged. No regression migration needed.

## Constitution Check

Project has no `.specify/memory/constitution.md`, so no explicit
constitutional constraints to verify against. General CLAUDE.md rules
observed:

- **Changeset gate** — one new `.changeset/1063-cluster-cockpit-reply.md`
  file, `minor` bump on `@generacy-ai/cluster-relay`. Test-only exemption
  does not apply here (schema + router logic are non-test `src/` changes).
- **No new dependencies** — verified.
- **Additive, no consumer breakage** — verified: appending a union member
  cannot narrow the acceptance surface of any existing message type; the
  short-circuit branch is guarded by `message.type === 'cluster.cockpit.reply'`
  which is unreachable pre-change (the parser dropped these messages).

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `.passthrough()` adds memory pressure on high-frequency messages. | Reply is one-per-gate-frame, not per-request. Volume is bounded by gate rate (≪ 1/s in normal ops). |
| A future subscriber registers a handler that begins side-effecting on `cluster.cockpit.reply` before #1059's correlation lands. | Q3=A short-circuit makes this structural: handlers cannot see the message. Regression test added to enforce. |
| Cloud diverges from documented shape (e.g. renames `wroteDoc` → `wroteDocument`). | `.passthrough()` preserves the new key; the schema still parses successfully as long as `type`, `timestamp`, `frameId`, `frameType`, `gateId`, `accepted` remain intact. Older renames silently vanish from typed access but survive at runtime. |
| `frameId` is documented as `string \| null` — cloud sends `null` today. | Typed as `z.string().nullable()`; both branches accepted. |

## Sequencing

Single commit (test + implementation + changeset) — no phased rollout, no
migration. Ship on merge.

## Next Step

Run `/speckit:tasks` to generate the task list.
