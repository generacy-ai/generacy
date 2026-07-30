# Contract: `FakeCloudStore`

**Feature**: #1068 | **Entity**: `E2` in [data-model.md](../data-model.md) | **Location**: `packages/orchestrator/src/__tests__/cockpit-gates/fake-cloud-store.ts` (NEW)

In-memory stand-in for the generacy-cloud Firestore `organizations/{orgId}/cockpitGates/{gateId}` collection. Backs the fake HTTP handler that services `GET /cockpit/gates` for `CloudGateQueryClient`.

## Constructor

```ts
function createFakeCloudStore(options?: FakeCloudStoreOptions): FakeCloudStore;

interface FakeCloudStoreOptions {
  /**
   * When false, `putGateFromWireFrame` drops the `generation` field before
   * storing (Phase A revert simulation per `revert-scenarios.md`).
   * Default: true.
   */
  persistGeneration?: boolean;
}
```

## Methods

### `putGateFromWireFrame(payload: GateOpenWire): void`

Ingest a validated `cluster.cockpit` gate-open frame payload (see [fake-peer-payload-schema.md](./fake-peer-payload-schema.md) for the validation gate).

**Preconditions**:
- `payload` has passed `GateOpenWireSchema.safeParse` — the fake peer's payload validator is upstream of this call.
- `payload.gateId.length === 24`.

**Behaviour**:
- Derives internal `gateKey` via `deriveGateKey(payload.issueRef, payload.gateType, payload.gateKey.split(':').at(-1), payload.runId)`. **Simpler**: use `payload.gateKey` verbatim — the tool already derived it and it's on the wire.
- Constructs a `GateDoc` with `status: 'open'`.
- When `options.persistGeneration === false`: sets `doc.generation = undefined` before store insert (revert simulation).
- Upserts on `gateId`: a re-emission of the same gate replaces the doc's mutable fields (per Q5=B / #1053 within-run cloud dedup semantics), preserving `gateKey` and `askedAt` on the first insert.

**Postconditions**: `store.get(payload.gateId)` returns a `GateDoc` with the above shape.

**Failure modes**: none — validation upstream. Any `TypeError` inside the store is a fake-implementation bug (fail-loud).

---

### `applyOutcome(gateId: string, outcome: GateOutcome, detail?: string): void`

Ingest a validated `cluster.cockpit` gate-outcome frame payload.

**Behaviour**:
- Look up the doc by `gateId`. If absent → no-op (matches the real cloud's "unknown gate → drop" behaviour on gate-outcome ingest per `message-handler.ts` — the harness records this as a `payloadViolation` from the peer side, not a store error).
- Transitions `status` per the outcome:
  - `outcome === 'applied'` → `status = 'applied'`.
  - `outcome === 'superseded'` → `status = 'superseded'`.
  - `outcome === 'failed'` → `status = 'failed'`.
- Sets `doc.lastOutcome = { outcome, detail, at: now() }`.

**Postconditions**: `store.get(gateId).status` reflects the new terminal.

---

### `putRaw(doc: GateDoc): void`

Direct write bypassing derivation. Used ONLY by FR-009 for hand-crafted pre-Phase-A docs (no `generation` field).

**Behaviour**: insert `doc` at key `doc.gateId`. No validation of `gateKey` shape, no invariant checks on `deriveGateKey` — the caller owns correctness. This method exists specifically to enable the FR-009 scenario where the doc's shape predates the derivation contract.

---

### `getByKey(issueRef: string, gateType: GateType, generation: string | number, runId?: string): GateDoc | null`

Status-mode lookup, backing the fake HTTP handler when it sees a `?generation=...` query.

**Behaviour**:
- Compute `lookupKey = deriveGateKey(issueRef, gateType, String(generation), runId)`.
- Compute `lookupId = deriveGateId(lookupKey)`.
- Return `store.get(lookupId) ?? null`.

**Invariant**: same helper the cluster's `cockpit_gate_open` uses to derive the writer-side id (D-5). A drift between the two derivations is a spec bug in this harness.

---

### `listByIssueRef(issueRef: string, gateType?: GateType): GateDoc[]`

List-mode lookup, backing the fake HTTP handler when it sees no `?generation=`.

**Behaviour**:
- Iterate `store.values()`.
- Filter by `doc.issueRef === issueRef`.
- If `gateType` present, also filter by `doc.gateType === gateType`.
- **Do NOT filter by status** — the orchestrator route (`packages/orchestrator/src/routes/cockpit-gates.ts:112-127`) applies its own non-terminal filter (`collapseListEntryStatus`). Fake returns raw; route collapses.
- Return array in insertion order (deterministic for assertions).

---

## HTTP endpoint shape (fake handler side)

The fake HTTP handler wraps this store and speaks the wire shape that `packages/orchestrator/src/services/cloud-gate-query-client.ts:78-114` expects:

**Status mode** (`GET /api/clusters/<clusterId>/cockpit/gates?issueRef=...&gateType=...&generation=...[&runId=...]`):

```json
// Body:
{ "gateId": "<24-hex>", "status": "open" | "answered" | "delivered" | "applied" | "superseded" | "failed" | "expired" }
// or (not found):
{ "gateId": null, "status": null }
```

**List mode** (`GET /api/clusters/<clusterId>/cockpit/gates?issueRef=...[&gateType=...]`):

```json
{
  "gates": [
    {
      "gateId": "<24-hex>",
      "gateType": "phase-queue",
      "generation": "P2",
      "status": "open"
    }
  ]
}
```

**Note on `generation` in list entries**: when the store has a doc with `generation: undefined` (FR-009 or persistGeneration=false), the fake still emits an entry — with `generation: '<absent>'` sentinel or omitted from the JSON. **Chosen**: omit from the JSON. The MCP tool's `CockpitGateListEntrySchema` requires `generation: z.string().min(1)`, so an absent-generation entry becomes an `internal` error at the MCP boundary — which IS the FR-009 assertion (the fallback code path renders the doc as visible-but-degraded, not as a full entry).

Wait — re-reading `CockpitGateListEntrySchema`: it requires `generation: z.string().min(1)`. That means the pre-Phase-A fallback MUST substitute *something* server-side. **Decision**: fake substitutes the literal string `'<pre-phase-a>'` when a doc has `generation: undefined`. FR-009 asserts the entry surfaces with this sentinel. This matches how a real pre-migration doc would appear in the fallback.

## Errors

- `putRaw` with a non-24-char `gateId` → throws `Error('FakeCloudStore.putRaw: invalid gateId length')`. Caller is a test; a bad id is a test bug.
- HTTP handler on a query with a missing `issueRef` → returns 400 with `{ error: 'missing issueRef' }`. Not exercised by any FR (all tools set it) but pinned to match the real cloud's rejection shape.

## Non-behaviours

- **No time-travel dedup / gate expiry.** Cloud has expiry logic; fake does not.
- **No cross-issueRef aggregation.** One store instance covers one epic; scenarios needing multiple can construct multiple stores.
- **No orgId scoping.** The real cloud key is `organizations/{orgId}/cockpitGates/{gateId}`; the fake is single-org.
- **No pagination.** `truncated` field never emitted (harness scenarios stay below any realistic page size).
