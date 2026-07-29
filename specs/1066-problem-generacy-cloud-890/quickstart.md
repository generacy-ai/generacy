# Quickstart: Thread `frameId` through `GateOpenSchema` / `GateOutcomeSchema` and orchestrator route

## Prerequisites

- Node.js >=22
- pnpm (workspace-managed)

No Docker, no live Redis, no live generacy-cloud instance needed for this feature — SC-001's integration test uses a real `ws` `WebSocketServer` in-process as the fake relay peer.

## Installation

Standard monorepo install:

```bash
pnpm install
```

## Build

```bash
pnpm --filter @generacy-ai/cockpit build
pnpm --filter @generacy-ai/orchestrator build
```

## Test invocation

**All `@generacy-ai/cockpit` tests** (fastest first check — asserts schema-level behavior):

```bash
pnpm --filter @generacy-ai/cockpit test
```

**All `@generacy-ai/orchestrator` cockpit-gates tests** (route + retainer + integration):

```bash
pnpm --filter @generacy-ai/orchestrator test -- cockpit-gates
```

**Only the new `frameId`-focused tests**:

```bash
# Schema unit tests
pnpm --filter @generacy-ai/cockpit test -- gates-schemas

# Route + retainer + integration
pnpm --filter @generacy-ai/orchestrator test -- \
  cockpit-gates \
  retained-cockpit-events \
  cockpit-gates-frameid.integration
```

## Manual reproduction — before/after

**Before this fix**, a POST including `frameId` silently drops it:

```bash
curl -X POST http://127.0.0.1:<orchestrator-port>/cockpit/gates \
  -H 'content-type: application/json' \
  -d '{
    "type": "gate-open",
    "gateId": "a1b2c3d4e5f6a7b8c9d0e1f2",
    "gateKey": "generacy-ai/generacy#1021:clarification:batch-1",
    "gateType": "clarification",
    "epicRef": "generacy-ai/generacy#1000",
    "issueRef": "generacy-ai/generacy#1021",
    "issueTitle": "Do the thing",
    "issueUrl": "https://github.com/generacy-ai/generacy/issues/1021",
    "title": "Clarification needed",
    "body": "Please choose",
    "options": [{"id": "proceed", "label": "Proceed"}],
    "allowFreeText": true,
    "sessionId": "sess_1",
    "askedAt": "2026-07-21T15:04:05.123Z",
    "frameId": "frm_test_123"
  }'
```

**Before**: the outbound `EventMessage.data` has no `frameId` key. Cloud reply carries `frameId: null`.

**After**: the outbound `EventMessage.data` includes `"frameId": "frm_test_123"`. Cloud reply echoes `frameId: "frm_test_123"`.

You can observe the outbound frame from the orchestrator's structured logs (`cockpit gate emitted` log line at `cockpit-gates.ts:170-173`) or by attaching to the relay wire directly.

## Success-criteria checklist

Run before opening the PR:

- [ ] `pnpm --filter @generacy-ai/cockpit test` — green (SC-003, SC-004 partial)
- [ ] `pnpm --filter @generacy-ai/orchestrator test -- cockpit-gates` — green (SC-002, SC-004, SC-005)
- [ ] `pnpm --filter @generacy-ai/orchestrator test -- cockpit-gates-frameid.integration` — green (SC-001 — the load-bearing wire-level assertion)
- [ ] `.changeset/1066-frame-id-wire.md` exists and bumps `@generacy-ai/cockpit` minor + `@generacy-ai/orchestrator` patch

## Troubleshooting

**The integration test hangs**: The fake `ws` peer in `cockpit-gates-frameid.integration.test.ts` waits for the orchestrator to `client.send(...)`. If the orchestrator's `ClusterRelayClient` isn't fully connected before the POST is issued, the frame goes to the retainer instead of the wire, and `peer.received` stays empty. Follow the pattern in `packages/cluster-relay/tests/relay.test.ts` for `waitFor(client.isConnected)` before the POST; add a timeout so failures surface as test errors, not hangs.

**Existing tests fail with "unknown key 'frameId'" errors**: Zod `.strict()` is NOT used on either `GateOpenSchema` or `GateOutcomeSchema`; unknown keys are stripped by default (this is exactly the bug this feature fixes). If a test suddenly rejects `frameId`, something else in the schema layered `.strict()` on top — investigate that first, do not add `.passthrough()` (which would undo the strict-boundary invariant of US2).

**`'frameId' in parsed === true` after supplying `""`**: The `""` → `undefined` transform is not firing. Check the field shape — the union must have `z.literal('').transform(() => undefined)` as one branch, and the whole union must have `.optional()` on top. `z.string().optional()` alone does NOT normalize `""`.

**Outbound frame shows `"frameId": null` instead of key absence**: Something is serializing an explicit `null` for the field. `JSON.stringify({ a: undefined })` produces `"{}"`, not `'{"a":null}"'` — so if you see `null`, the value is being converted to `null` somewhere between parse and send. Check that `tryEmitOrRetain` is called with `data: parsed` (not a copy that fills in `null`s).

**Cloud reply still carries `frameId: null`**: SC-001 exercises the cluster wire only. If SC-001 passes but the cloud reply is null, the cloud is not reading `data.frameId` as expected — verify the cloud's `services/api/src/services/relay/message-handler.ts:804` matches the quotation in clarifications.md Q1 answer. This is a cross-repo state that Q4 → A confirmed as of 2026-07-29; if a subsequent cloud release changes the read site, that becomes a companion cloud issue.

## Available commands

None — this feature adds no new user-visible commands or CLI surface. It is a wire-schema fix visible only to programmatic callers (MCP tools, doorbell, ad-hoc HTTP clients) that supply `frameId` on the request body.
