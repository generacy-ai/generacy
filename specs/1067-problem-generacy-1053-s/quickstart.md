# Quickstart: `runId` on gate-query MCP tools (Phase B of #1053 fix)

**Issue**: [#1067](https://github.com/generacy-ai/generacy/issues/1067)
**Branch**: `1067-problem-generacy-1053-s`

## Prereqs

- pnpm workspace bootstrapped (`pnpm install` at repo root).
- Node ≥ 22.
- Familiarity with `packages/generacy/src/cli/commands/cockpit/mcp/` layout.

## Landing check (BEFORE MERGE)

Cloud Phase A must be deployed to prod. On-call verifies via:

```bash
# Confirm cloud accepts optional runId on write path:
curl -sSL -X POST "$GENERACY_API_URL/api/clusters/$CLUSTER_ID/cockpit/gates" \
  -H "authorization: Bearer $CLUSTER_API_KEY" \
  -H "content-type: application/json" \
  -d '{"type":"gate-open","runId":"probe-1067", ...}'
# Expect 202. If 400 mentions "unknown key: runId", Phase A is NOT deployed.

# Confirm cloud accepts optional runId on status read path:
curl -sSL "$GENERACY_API_URL/api/clusters/$CLUSTER_ID/cockpit/gates?issueRef=...&gateType=...&generation=...&runId=probe-1067" \
  -H "authorization: Bearer $CLUSTER_API_KEY"
# Expect 200 with `{gateId, status}`. If 400 "unknown key: runId", Phase A is NOT deployed.

# Confirm cloud rejects runId on list mode (deployed refine):
curl -sSL "$GENERACY_API_URL/api/clusters/$CLUSTER_ID/cockpit/gates?issueRef=...&runId=probe-1067" \
  -H "authorization: Bearer $CLUSTER_API_KEY"
# Expect 400 "runId requires generation". If 200, Phase A ships without the refine — coordinate with cloud team.
```

The check is not automated in this PR — treat it as a manual gate item.

## Local development

### Running the widened schemas

```typescript
import { CockpitGateStatusInputSchema } from '@generacy-ai/generacy/cli/commands/cockpit/mcp/gates/query-schemas';

// Pre-#1067 shape — still valid (SC-002):
CockpitGateStatusInputSchema.safeParse({
  issueRef: 'generacy-ai/generacy#1067',
  gateType: 'implementation-review',
  generation: 'abc123',
}); // { success: true }

// Post-#1067 4-tuple shape — newly valid (US2):
CockpitGateStatusInputSchema.safeParse({
  issueRef: 'generacy-ai/generacy#1067',
  gateType: 'implementation-review',
  generation: 'abc123',
  runId: 'auto-cluster-1067-1722243247891',
}); // { success: true }

// Wrong parameter name (Q2 landmine) — still fails via .strict():
CockpitGateStatusInputSchema.safeParse({
  issueRef: '...',
  gateType: '...',
  generation: '...',
  run_id: 'oops',
}); // { success: false, error.issues: [{ code: 'unrecognized_keys', ... }] }
```

### Invoking the widened tool

```typescript
import { cockpitGateStatus } from '@generacy-ai/generacy/cli/commands/cockpit/mcp/tools/cockpit_gate_status';

// Same call site as today, plus optional runId:
const result = await cockpitGateStatus({
  issueRef: 'generacy-ai/generacy#1067',
  gateType: 'implementation-review',
  generation: 'abc123',
  runId: 'auto-cluster-1067-1722243247891',   // NEW
});

if (result.status === 'ok') {
  console.log(result.data);  // { gateId, status: 'open' | 'answered' | 'absent' }
}
```

`cockpit_gate_list` — same pattern, but note the **runId is dropped** at the
handler (deliberate; Q1=C):

```typescript
import { cockpitGateList } from '@generacy-ai/generacy/cli/commands/cockpit/mcp/tools/cockpit_gate_list';

// runId is ACCEPTED (schema-valid) but NOT forwarded to the cloud:
const result = await cockpitGateList({
  issueRef: 'generacy-ai/generacy#1067',
  gateType: 'implementation-review',
  runId: 'auto-cluster-1067-1722243247891',  // schema-valid; discarded
});
```

## Running the tests

```bash
# All relevant tests for this PR:
pnpm --filter @generacy-ai/generacy test -- --run \
  packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-status.test.ts \
  packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-list.test.ts \
  packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-tuple-identity.test.ts \
  packages/generacy/src/cli/commands/cockpit/mcp/__tests__/cockpit-gate-status-runid.test.ts \
  packages/generacy/src/cli/commands/cockpit/mcp/__tests__/gate-open-then-status-runid.integration.test.ts \
  packages/generacy/src/cli/commands/cockpit/mcp/__tests__/observer-independence.test.ts

pnpm --filter @generacy-ai/orchestrator test -- --run \
  packages/orchestrator/src/services/__tests__/cloud-gate-query-client.runid.test.ts \
  packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts
```

Fast local sanity:
```bash
pnpm typecheck
```
Expected: zero errors (SC-008).

## Success-criterion mapping

| SC     | Test file                                                          | Assertion                                                                                     |
|--------|--------------------------------------------------------------------|-----------------------------------------------------------------------------------------------|
| SC-001 | `cloud-gate-query-client.runid.test.ts`                            | Snapshot equality of no-runId URL + structural key-set assertion.                             |
| SC-002 | `parity-gate-status.test.ts`                                       | `.safeParse` of 3-field input returns byte-identical parsed shape.                            |
| SC-003 | `cloud-gate-query-client.runid.test.ts`                            | With runId supplied, outbound URL contains `runId=<value>` (camelCase). List URL never carries it. |
| SC-004 | `gate-open-then-status-runid.integration.test.ts`                  | Fake-cloud round-trip: open + status with same runId → `'open'`.                              |
| SC-005 | `parity-gate-tuple-identity.test.ts`                               | 3 tools × {3-tuple, 4-tuple, distinct runId, empty generation boundary} identity matrix.      |
| SC-006 | `parity-gate-status.test.ts` + `parity-gate-list.test.ts`          | MCP `inputSchema` remains flat `z.object` with non-empty `properties`.                        |
| SC-007 | `observer-independence.test.ts`                                    | Existing test passes unchanged.                                                               |
| SC-008 | `pnpm typecheck`                                                   | Zero TypeScript errors after change.                                                          |

## Troubleshooting

### "Cluster gets a 202 but the inbox stays empty"

Symptom of the #1053 root cause. Verify:
1. Cloud Phase A is deployed (landing check above).
2. Caller is passing `runId` on `cockpit_gate_open` too (Phase C — agency-side).
3. The log line `cockpit_gate_status.runid-source` shows `runIdSource: 'explicit'` — if `'unset'`, the caller is not threading `runId`.

If all three hold and the inbox is still empty, the bug is downstream (cloud-side gate storage) and out of scope for this PR.

### "TypeScript complains about `runId` on an existing call site"

The field is optional (`runId?: string`) — existing call sites compile unchanged. If a call site suddenly errors, check that the caller isn't spreading an untyped object with a wrong-cased key (`run_id`) that the `.strict()` schema now rejects.

### "The snapshot test fails after a legitimate refactor"

Regenerate `contracts/cloud-url.md`'s canonical URL in the same commit. The
structural assertion continues to pass on legitimately additive parameters,
but the snapshot needs a manual bump — this is intentional (FR-005 says
byte-identical, and byte-identical means the snapshot is authoritative).

## Deferred (post-merge)

- `generacy-ai/agency` Phase C: thread `runId` through `/cockpit:auto` on both open + status/list calls. This is what flips the fix on end-to-end. Without Phase C, this PR is functional but the fix is dormant on the live cluster.
- `generacy-ai/generacy-cloud` follow-up: add `runId` filter to list mode (deployed contract 400s; operator use case is real).
