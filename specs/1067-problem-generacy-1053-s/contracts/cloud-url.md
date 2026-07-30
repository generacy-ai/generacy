# Contract: outbound cloud URL shape (canonical snapshot)

**Issue**: [#1067](https://github.com/generacy-ai/generacy/issues/1067)
**File**: `packages/orchestrator/src/services/cloud-gate-query-client.ts::buildUrl`

This contract is the source of truth for the byte-identical snapshot used by
the FR-005 verification test (SC-001).

## Canonical inputs

```ts
const clusterId  = 'cluster-abc-123';       // 4-tuple canonical
const apiUrlEnv  = 'https://api.generacy.ai';
const issueRef   = 'generacy-ai/generacy#42';
const gateType   = 'implementation-review';
const generation = 'abc123';
```

## Canonical URLs

### `getGateStatus` — `runId` OMITTED (byte-compat with pre-#1067)

```
https://api.generacy.ai/api/clusters/cluster-abc-123/cockpit/gates?issueRef=generacy-ai%2Fgeneracy%2342&gateType=implementation-review&generation=abc123
```

**Verification**:
- Snapshot equality: assert full URL string equals the above (catches percent-encoding drift on `#` → `%23` and `/` → `%2F`; catches parameter-order drift).
- Structural: assert `searchParams.keys()` returns exactly `['issueRef', 'gateType', 'generation']` in this order; assert `.has('runId') === false`.

### `getGateStatus` — `runId` SUPPLIED (Phase B behaviour under test)

```
https://api.generacy.ai/api/clusters/cluster-abc-123/cockpit/gates?issueRef=generacy-ai%2Fgeneracy%2342&gateType=implementation-review&generation=abc123&runId=auto-cluster-1067-1722243247891
```

**Verification**:
- Assert `searchParams.get('runId') === 'auto-cluster-1067-1722243247891'`.
- Assert `searchParams.get('runId') !== null` (present).
- Query-string key is **`runId`** (camelCase), NOT `run_id` — pinned by the deployed cloud contract at `generacy-cloud@192fca7c` (Q2=A).

### `listGates` — `runId` NEVER carried

```
https://api.generacy.ai/api/clusters/cluster-abc-123/cockpit/gates?issueRef=generacy-ai%2Fgeneracy%2342&gateType=implementation-review
```

**Verification**:
- Even when the upstream MCP call includes `runId`, the outbound URL from `listGates` MUST NOT contain the parameter (handler drop in `cockpit_gate_list.ts` enforces this).
- Assert `.has('runId') === false` for the list URL under all input permutations.

## Encoding invariants

| Character in `issueRef` | Encoded as | Notes                                                              |
|-------------------------|------------|--------------------------------------------------------------------|
| `/` (path separator)    | `%2F`      | `URLSearchParams` encodes it because it's a query value, not path. |
| `#` (fragment)          | `%23`      | Critical — un-encoded, everything after `#` is stripped as fragment; cloud sees a truncated `issueRef`. |

Refactors that swap `URLSearchParams` for manual concatenation MUST re-implement both encodings (or the snapshot test at `cloud-gate-query-client.runid.test.ts` will catch it in the same commit).

## Query-string parameter order

`URLSearchParams.set(k, v)` preserves insertion order. Insertion order in the
current implementation is `issueRef`, `gateType`, `generation`, `runId?`
(via the `for (const [k, v] of Object.entries(query))` loop at
`cloud-gate-query-client.ts:206-208`; `Object.entries` order matches the
literal order of the query object at the call site).

If insertion order changes, the snapshot test fails and the canonical URL
above MUST be regenerated in the same commit that changes the order.

## Non-goals

- Percent-encoding of `runId` — the canonical fixture uses characters that don't require encoding. If a future caller passes a `runId` with special characters, `URLSearchParams` handles it correctly by construction.
- URL length limits — not enforced by this contract. Cloud rejects with 414 if exceeded; that's a cloud responsibility.
