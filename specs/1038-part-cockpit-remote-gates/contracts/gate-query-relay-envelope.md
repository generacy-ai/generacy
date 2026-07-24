# Relay envelope contract: `gate_query_request` / `gate_query_response`

**Issue**: [#1038](https://github.com/generacy-ai/generacy/issues/1038)
**File**: `packages/cluster-relay/src/messages.ts`
**Data model**: [data-model.md §5](../data-model.md)
**Cross-repo dep**: [generacy-cloud sibling — cloud responder] (companion issue, out of scope here)

New relay envelope pair added to `RelayMessage` union and `RelayMessageSchema`. Enables **cluster→cloud** request/response for gate-status queries, ridng the SAME WebSocket that carries `gate-open` events and `event`-typed cluster-to-cloud pushes. Preserves the spec's single-transport invariant (Assumptions §96).

This file is the source of truth for the generacy-cloud sibling's cloud responder — the cloud reads this contract, mirrors the shape, and implements the Firestore query.

---

## Direction & framing

- `gate_query_request`: cluster **→** cloud.
- `gate_query_response`: cloud **→** cluster (correlated echo of `correlationId`).
- Both frames are JSON-encoded `RelayMessage` variants sent over the existing WebSocket.
- No compression, no chunking. The response is a single frame; if payload size becomes a problem, add server-side pagination via a `cursor` field additively (not v1).

---

## `gate_query_request` (cluster → cloud)

### TypeScript

```typescript
export interface GateQueryRequestMessage {
  type: 'gate_query_request';
  /** UUID or short random hex — echoed on the response. */
  correlationId: string;
  /** owner/repo#N — the issue whose gates we're querying. */
  issueRef: string;
  /** 'single' targets one natural gate; 'list' enumerates non-terminal gates. */
  mode: 'single' | 'list';
  /** Required when mode='single'. One of the 8 GateType enum values. */
  gateType?: GateType;
  /** Required when mode='single'. String OR number — coerced identically to gate-open. */
  generation?: string | number;
  /** Optional narrowing for mode='list' — v1 filters client-side; here for future server-side optimization. */
  gateTypeFilter?: GateType;
}
```

### Zod

```typescript
export const GateQueryRequestMessageSchema = z.object({
  type: z.literal('gate_query_request'),
  correlationId: z.string().min(1),
  issueRef: z.string().min(1),
  mode: z.enum(['single', 'list']),
  gateType: GateTypeSchema.optional(),
  generation: z.union([z.string().min(1), z.number()]).optional(),
  gateTypeFilter: GateTypeSchema.optional(),
});
```

### Cross-field rules (enforced at construction site, not by Zod schema)

- `mode: 'single'` REQUIRES both `gateType` AND `generation`.
- `mode: 'list'` MUST NOT set `generation`. If set, cloud ignores it.
- `gateTypeFilter` is meaningful ONLY when `mode: 'list'`.

Cloud MUST reject requests violating these constraints with a `gate_query_response { status: 'error', error: '<reason>' }`.

### Sample requests

Single:

```json
{
  "type": "gate_query_request",
  "correlationId": "018f4b8e-7c1d-71a2-9b3c-4d5e6f708192",
  "issueRef": "generacy-ai/generacy#1038",
  "mode": "single",
  "gateType": "clarification",
  "generation": "a3f9e2b1c4d5e6f7a8b9c0d1"
}
```

List:

```json
{
  "type": "gate_query_request",
  "correlationId": "018f4b8e-7c1d-71a2-9b3c-4d5e6f708193",
  "issueRef": "generacy-ai/generacy#1038",
  "mode": "list"
}
```

---

## `gate_query_response` (cloud → cluster)

### TypeScript

```typescript
export interface GateQueryResponseMessage {
  type: 'gate_query_response';
  /** Echoes the request's correlationId — cluster uses this to route to the pending promise. */
  correlationId: string;
  /** 'ok' payload is populated; 'error' error is populated. Never both. */
  status: 'ok' | 'error';
  payload?:
    | {
        mode: 'single';
        /** Cluster-provided in the request; cloud echoes verbatim. NOT re-derived. */
        gateId: string;
        /** Three-state — cloud collapses its seven-status enum per the mapping table. */
        status: 'open' | 'answered' | 'absent';
      }
    | {
        mode: 'list';
        /**
         * Non-terminal gates only. Terminal statuses (applied|superseded|failed|expired)
         * are excluded server-side. Project-wide scope (any cluster in the project).
         */
        gates: Array<{
          gateId: string;
          gateType: GateType;
          /** 'open' verbatim; cloud 'delivered' collapses to 'answered' here. */
          status: 'open' | 'answered';
        }>;
      };
  /** Present iff status='error'. Human-readable — surfaced in cluster logs. */
  error?: string;
}
```

### Zod

```typescript
const GateQueryResponseSinglePayloadSchema = z.object({
  mode: z.literal('single'),
  gateId: z.string().length(24),
  status: z.enum(['open', 'answered', 'absent']),
});

const GateQueryResponseListPayloadSchema = z.object({
  mode: z.literal('list'),
  gates: z.array(
    z.object({
      gateId: z.string().length(24),
      gateType: GateTypeSchema,
      status: z.enum(['open', 'answered']),
    }),
  ),
});

export const GateQueryResponseMessageSchema = z.object({
  type: z.literal('gate_query_response'),
  correlationId: z.string().min(1),
  status: z.enum(['ok', 'error']),
  payload: z
    .union([GateQueryResponseSinglePayloadSchema, GateQueryResponseListPayloadSchema])
    .optional(),
  error: z.string().optional(),
});
```

### Cross-field rules

- `status: 'ok'` REQUIRES `payload`.
- `status: 'error'` REQUIRES `error`.
- Payload's inner `mode` MUST match the request's `mode` (protects against cloud-side dispatcher bugs). Cluster orchestrator MAY drop the response if these don't match; treated as a `MalformedCloudResponseError`.

### Sample responses

Ok (single):

```json
{
  "type": "gate_query_response",
  "correlationId": "018f4b8e-7c1d-71a2-9b3c-4d5e6f708192",
  "status": "ok",
  "payload": {
    "mode": "single",
    "gateId": "1a2b3c4d5e6f7a8b9c0d1e2f",
    "status": "open"
  }
}
```

Ok (list):

```json
{
  "type": "gate_query_response",
  "correlationId": "018f4b8e-7c1d-71a2-9b3c-4d5e6f708193",
  "status": "ok",
  "payload": {
    "mode": "list",
    "gates": [
      { "gateId": "1a2b3c4d5e6f7a8b9c0d1e2f", "gateType": "clarification", "status": "open" },
      { "gateId": "3f4e5d6c7b8a9012345abcde", "gateType": "implementation-review", "status": "answered" }
    ]
  }
}
```

Error:

```json
{
  "type": "gate_query_response",
  "correlationId": "018f4b8e-7c1d-71a2-9b3c-4d5e6f708192",
  "status": "error",
  "error": "firestore query timeout after 5000ms"
}
```

---

## Cloud responder responsibilities (informational — this is on generacy-cloud)

For cross-repo alignment, the cloud responder MUST:

1. **Validate the request** against `GateQueryRequestMessageSchema`. Reject with `status: 'error'` on Zod failure — do NOT drop silently.
2. **Enforce project scoping**. The relay handshake's `clusterId` maps to a `projectId`; the responder queries Firestore for gates in that project only. Cross-project queries MUST return an empty list (`mode: 'list'`) or `absent` (`mode: 'single'`), NOT a 4xx-equivalent.
3. **Preserve `correlationId` verbatim**. The response's `correlationId` MUST byte-match the request's.
4. **Do the status collapse server-side**. Cluster consumes the 3-state / 2-state result directly; never sees the raw 7-value cloud enum. Mapping is authoritative in [data-model.md §1](../data-model.md).
5. **Exclude terminal statuses from `mode: 'list'`** — `applied`, `superseded`, `failed`, `expired` are dropped from the array. Same collapse for the single-mode response, but the tool surfaces `absent` for terminal-negative and `answered` for `applied` (matches R2).
6. **Fail loud on ambiguous state**. Never invent an `absent` on a bug — always prefer `status: 'error'` so the cluster's retry loop can react properly.

## Cluster consumer responsibilities

- Route inbound `gate_query_response` by `correlationId` to the pending promise (see `GateStatusQueryService.onRelayMessage`).
- Drop responses whose `correlationId` has no matching pending entry (either the timer already fired, or the response is stale from a prior process instance).
- On response validation failure (Zod), reject the promise with `MalformedCloudResponseError`.
- On `status: 'error'`, reject the promise with `QueryUnreachableError(lastReason: payload.error)`. NOT `MalformedCloudResponseError` — a well-formed error response is still a well-formed message.

---

## Union registration

`packages/cluster-relay/src/messages.ts` gains both variants:

```typescript
export type RelayMessage =
  | ApiRequestMessage
  | ApiResponseMessage
  | EventMessage
  | ConversationMessage
  | HeartbeatMessage
  | HandshakeMessage
  | ErrorMessage
  | LeaseRequestMessage
  | LeaseReleaseMessage
  | LeaseHeartbeatMessage
  | LeaseResponseMessage
  | SlotAvailableMessage
  | ClusterRejectedMessage
  | TierInfoMessage
  | TunnelOpenMessage
  | TunnelOpenAckMessage
  | TunnelDataMessage
  | TunnelCloseMessage
  | GateQueryRequestMessage     // NEW (#1038)
  | GateQueryResponseMessage;   // NEW (#1038)

export const RelayMessageSchema = z.discriminatedUnion('type', [
  // ... existing 18 schemas ...
  GateQueryRequestMessageSchema,   // NEW
  GateQueryResponseMessageSchema,  // NEW
]);
```

`packages/cluster-relay/src/index.ts` re-exports both interfaces + both schemas so orchestrator consumers can `import { GateQueryRequestMessage } from '@generacy-ai/cluster-relay'` for type-narrowing without reaching into the internal module.

---

## Versioning

- Additive change to `RelayMessage` union → semver **patch** for `@generacy-ai/cluster-relay`.
- No breaking change to existing envelopes; existing consumers that switch on `msg.type` see two new variants they don't handle, which is exhaustively handled the same way an unknown legacy `event` `type` is: silently ignored / handled by default clause.

---

## Test coverage

**Unit** (`packages/cluster-relay/src/__tests__/messages.test.ts`, extended):
- Round-trip: parse a well-formed `gate_query_request` → matches the TypeScript interface.
- Round-trip: parse a well-formed `gate_query_response` (both single + list payloads) → matches.
- Malformed: `gate_query_response` with `status: 'ok'` but no `payload` → `parseRelayMessage` returns null.
- Malformed: `gate_query_response` with `payload.gateId` of wrong length → returns null.
- Discriminated union: `parseRelayMessage({type: 'gate_query_unknown', …})` returns null.

**Integration** — covered by the #1024 harness extension (see `plan.md` § R10 / test strategy).
