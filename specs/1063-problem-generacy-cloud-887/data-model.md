# Data Model: `cluster.cockpit.reply`

## Overview

Adds one new wire-shape to the cluster relay message space. Purely additive
to `packages/cluster-relay/src/messages.ts`. No changes to existing types.

## Types

### `ClusterCockpitReplyMessage` (interface)

TypeScript shape mirrored from cloud's `ClusterCockpitReplyMessage`
(`services/api/src/services/relay/relay-types.ts` in generacy-cloud, per
spec Assumptions §1).

```ts
export interface ClusterCockpitReplyMessage {
  type: 'cluster.cockpit.reply';
  timestamp: string;
  /** Correlation id — `null` today; carries a real id in #1059 steps 4–7. */
  frameId: string | null;
  /**
   * Which frame class this reply acknowledges.
   * Known values (not enforced, per Q2=A):
   *   - 'gate-open'
   *   - 'gate-outcome'
   *   - 'unknown'
   */
  frameType: string;
  gateId: string;
  /** Present when the gate was resolvable to a key on the cloud side. */
  gateKey?: string;
  accepted: boolean;
  /** Present on both accepted and rejected replies; short reason code. */
  reason?: string;
  /** Present when the gate's status shifted; drop-class classification. */
  priorStatus?: string;
  /**
   * Present on `accepted: true`. Known values (not enforced, per Q2=A):
   *   - 'created'
   *   - 'rebound'
   */
  wroteDoc?: string;
}
```

### `ClusterCockpitReplyMessageSchema` (Zod)

```ts
/**
 * Cloud → cluster acknowledgement for every gate frame — both accepted:true
 * (happy path) and every drop class. Sender: generacy-cloud#887.
 *
 * Tolerance strategy (per specs/1063 clarifications):
 *   - .passthrough(): unknown top-level fields preserved (Q1=A). Future
 *     cloud fields land in log lines automatically.
 *   - frameType / wroteDoc / reason typed as open z.string(): unknown values
 *     do not fail parsing (Q2=A). Enums documented here, not enforced.
 *
 * Known frameType: 'gate-open' | 'gate-outcome' | 'unknown'
 * Known wroteDoc:  'created' | 'rebound'
 * Known reason:    various short codes ('schema-invalid', 'stale', ...);
 *                  open per Q2=A.
 */
const ClusterCockpitReplyMessageSchema = z
  .object({
    type: z.literal('cluster.cockpit.reply'),
    timestamp: z.string(),
    frameId: z.string().nullable(),
    frameType: z.string(),
    gateId: z.string().min(1),
    gateKey: z.string().optional(),
    accepted: z.boolean(),
    reason: z.string().optional(),
    priorStatus: z.string().optional(),
    wroteDoc: z.string().optional(),
  })
  .passthrough();
```

## Validation Rules

| Field | Constraint | Rationale |
|---|---|---|
| `type` | `z.literal('cluster.cockpit.reply')` | Discriminator for `RelayMessageSchema` union. |
| `timestamp` | `z.string()` (not `.datetime()`) | Cloud may send non-strict-ISO strings; error-tolerant. Existing `EventMessageSchema` uses `.datetime()` — reply follows the looser lease-message convention (`timestamp: z.string().optional()` on `ApiRequestMessageSchema:228`). Wire-truth match to cloud. |
| `frameId` | `z.string().nullable()` | Cloud sends `null` today (D-5). Not optional — absence is a bug on the cloud side worth catching. |
| `frameType` | `z.string()` (open) | Q2=A. |
| `gateId` | `z.string().min(1)` | Required; empty string would be a malformed reply. Missing → parse fails → falls to existing warn branch per FR-008. |
| `gateKey` | `z.string().optional()` | Present when cloud resolved a run-scoped identity; absent otherwise. |
| `accepted` | `z.boolean()` | Router branches on this. |
| `reason` | `z.string().optional()` (open) | Q2=A. Present on drop paths and sometimes happy path. |
| `priorStatus` | `z.string().optional()` | Present on some drop classes; undefined on `accepted: true`. |
| `wroteDoc` | `z.string().optional()` (open) | Q2=A. Present only on `accepted: true`. |
| *(unknowns)* | preserved via `.passthrough()` | Q1=A. |

## Relationships

### `RelayMessage` union type extension

```ts
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
  | ClusterCockpitReplyMessage;   // NEW
```

### `RelayMessageSchema` union extension

```ts
export const RelayMessageSchema = z.discriminatedUnion('type', [
  ApiRequestMessageSchema,
  ApiResponseMessageSchema,
  EventMessageSchema,
  ConversationMessageSchema,
  HeartbeatMessageSchema,
  HandshakeMessageSchema,
  ErrorMessageSchema,
  LeaseRequestMessageSchema,
  LeaseReleaseMessageSchema,
  LeaseHeartbeatMessageSchema,
  LeaseResponseMessageSchema,
  SlotAvailableMessageSchema,
  ClusterRejectedMessageSchema,
  TierInfoMessageSchema,
  TunnelOpenMessageSchema,
  TunnelOpenAckMessageSchema,
  TunnelDataMessageSchema,
  TunnelCloseMessageSchema,
  ClusterCockpitReplyMessageSchema,   // NEW — 19th member
]);
```

## Type Exports

`ClusterCockpitReplyMessage` (interface) added to the `packages/cluster-relay`
public export surface via the existing `export interface` declaration in
`messages.ts`. This is what enables downstream consumers (in #1059 steps 4–7)
to import a typed shape without touching schema internals.

`ClusterCockpitReplyMessageSchema` (Zod) stays internal (no `export`) unless
a follow-up needs it — matching the pattern of the other per-type schemas in
this file which are only re-exported through `RelayMessageSchema` and the
type-inferred `RelayMessage` union.

## Wire Payload Examples

### Happy path (`accepted: true`, `wroteDoc: 'created'`)

```json
{
  "type": "cluster.cockpit.reply",
  "timestamp": "2026-07-28T12:34:56.789Z",
  "frameId": null,
  "frameType": "gate-open",
  "gateId": "gt_01HZQK...",
  "gateKey": "generacy-ai/generacy#1063:artifact-review:plan-review:abc123",
  "accepted": true,
  "wroteDoc": "created"
}
```

### Rebound (`accepted: true`, `wroteDoc: 'rebound'`)

```json
{
  "type": "cluster.cockpit.reply",
  "timestamp": "2026-07-28T12:34:56.789Z",
  "frameId": null,
  "frameType": "gate-outcome",
  "gateId": "gt_01HZQK...",
  "accepted": true,
  "wroteDoc": "rebound"
}
```

### Drop (`accepted: false`)

```json
{
  "type": "cluster.cockpit.reply",
  "timestamp": "2026-07-28T12:34:56.789Z",
  "frameId": null,
  "frameType": "gate-open",
  "gateId": "gt_01HZQK...",
  "accepted": false,
  "reason": "schema-invalid",
  "priorStatus": "unknown"
}
```

### Future extension (unknown top-level field, per SC-003)

```json
{
  "type": "cluster.cockpit.reply",
  "timestamp": "2026-07-28T12:34:56.789Z",
  "frameId": "req_abc",
  "frameType": "gate-cancel",
  "gateId": "gt_01HZQK...",
  "accepted": true,
  "wroteDoc": "reused",
  "cancelledBy": "operator"
}
```

Parses successfully (`.passthrough()` preserves `cancelledBy`; open
`z.string()` accepts `frameType: 'gate-cancel'` and `wroteDoc: 'reused'`).
Full object appears in the `debug` log line on the happy path.
