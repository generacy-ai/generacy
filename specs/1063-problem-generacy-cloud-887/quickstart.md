# Quickstart: `cluster.cockpit.reply` schema addition

## What this feature does

Before this change, the cluster logs `warn: Invalid relay message, skipping`
with the full payload attached on every gate acknowledgement cloud sends.
After this change, those become `debug`-level logs on the happy path and
`info`-level on drops. Operators debugging a stuck run stop seeing
misleading warns.

## Local dev

Standard package build/test loop; nothing feature-specific.

```bash
pnpm install
pnpm --filter @generacy-ai/cluster-relay build
pnpm --filter @generacy-ai/cluster-relay test
```

## Files to change

Two source files, two test files, one changeset:

| Path | Change |
|---|---|
| `packages/cluster-relay/src/messages.ts` | Add `ClusterCockpitReplyMessage` interface, `ClusterCockpitReplyMessageSchema` Zod schema, append to `RelayMessageSchema` union, extend `RelayMessage` type. |
| `packages/cluster-relay/src/relay.ts` | Add short-circuit branch in `ws.on('message', ...)` — after the `api_request` branch (`:315-322`), before the `messageHandlers` fanout (`:324-331`). |
| `packages/cluster-relay/tests/messages.test.ts` | New parse cases (accepted/dropped/passthrough/missing-gateId). |
| `packages/cluster-relay/tests/relay.test.ts` | New router log-level cases (SC-001, SC-002) + short-circuit assertion. |
| `.changeset/1063-cluster-cockpit-reply.md` | `@generacy-ai/cluster-relay` minor. |

## Behaviour reference

### `accepted: true` — debug log, no fanout

```ts
// Cloud sends:
{
  type: 'cluster.cockpit.reply',
  timestamp: '2026-07-28T…',
  frameId: null,
  frameType: 'gate-open',
  gateId: 'gt_01HZQK...',
  gateKey: 'generacy-ai/generacy#1063:plan-review:abc',
  accepted: true,
  wroteDoc: 'created',
}
// Cluster:
// - parseRelayMessage → returns the object
// - router logs at debug: { message: <full object> } 'cluster.cockpit.reply received'
// - router returns; messageHandlers do NOT see it
```

### `accepted: false` — info log, no fanout

```ts
// Cloud sends:
{
  type: 'cluster.cockpit.reply',
  timestamp: '2026-07-28T…',
  frameId: null,
  frameType: 'gate-open',
  gateId: 'gt_01HZQK...',
  accepted: false,
  reason: 'schema-invalid',
  priorStatus: 'unknown',
}
// Cluster:
// - parseRelayMessage → returns the object
// - router logs at info: { reason, frameType, gateId, priorStatus } 'cluster.cockpit.reply dropped'
// - router returns; messageHandlers do NOT see it
```

### Unknown top-level field — preserved

```ts
// Cloud sends (future):
{ type: 'cluster.cockpit.reply', /* ...required... */, futureField: 'x' }
// Cluster:
// - parseRelayMessage → returns object WITH `futureField` present (Q1=A .passthrough())
// - On accepted:true, debug log carries { futureField: 'x' } automatically
```

### Missing required field — falls to existing warn branch

```ts
// Cloud sends (malformed):
{ type: 'cluster.cockpit.reply', accepted: true /* no gateId */ }
// Cluster:
// - parseRelayMessage → null
// - existing branch: warn 'Invalid relay message, skipping' (FR-008)
```

## Troubleshooting

### Cluster still logs `Invalid relay message, skipping` after the fix

Confirm the cluster binary was rebuilt (`pnpm --filter @generacy-ai/cluster-relay build`)
and the running orchestrator loads the new `packages/cluster-relay/dist/`. In
dev, restart the orchestrator process.

If a specific `warn` line persists with `type: 'cluster.cockpit.reply'` in
the raw payload, inspect the raw object — it likely lacks a required field
(`gateId`, `type`, `timestamp`, `frameId`, `frameType`, `accepted`). This is
FR-008 working as intended; the fix is on the sender side.

### `debug` line does not appear

Set the logger level. Cluster uses pino; the cluster-relay `logger` is
injected by the orchestrator. Confirm `pino({ level: 'debug' })` or
`LOG_LEVEL=debug` in the orchestrator's launch env.

### A handler seems to be receiving reply messages

It should not. The short-circuit at the router `return`s before the
`messageHandlers` fanout (per Q3=A). If a handler is observing them, either
the short-circuit was removed accidentally or the handler is subscribing to
raw WebSocket data (bypassing `parseRelayMessage`). Grep for
`ws.on('message'` outside `packages/cluster-relay/src/relay.ts`.

## Cross-repo reference

- Cloud sender: `services/api/src/services/relay/relay-types.ts` in
  generacy-cloud (see #887, merged).
- Cross-repo wire contract: this repo's
  `specs/1063-problem-generacy-cloud-887/contracts/cluster-cockpit-reply.schema.json`
  (JSON Schema mirror of the Zod shape).
- Future correlation work: #1059 steps 4–7 (`frameId` passthrough,
  run-scoped gate identity, `cockpit_gate_status` wiring). Do **not** land
  correlation piecemeal — see spec Out of Scope §3.
