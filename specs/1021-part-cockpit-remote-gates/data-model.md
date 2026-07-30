# Data Model: Cockpit Remote Gates — orchestrator side

Entities are grouped by boundary: **wire payloads** (validated at HTTP ingress; also emitted on the relay), **in-memory state** (retain queue, dedup set), and **on-disk state** (answers.ndjson + rotated siblings).

Exact field names on the wire payloads are governed by the epic contract doc (`docs/cockpit-remote-gates-plan.md` in tetrad-development). The schemas below name every field the orchestrator **must** see, marks each `known` (definitionally present) vs. `passthrough` (accepted and forwarded but not inspected by the orchestrator), and lists validation rules the orchestrator enforces regardless of upstream contract drift.

## 1. Wire payloads (`packages/cockpit/src/gates/schema.ts`)

### 1.1 `GateOpenSchema`

Payload the in-cluster MCP posts to `POST /cockpit/gates` when a gate opens. Emitted verbatim on `cluster.cockpit`.

| Field | Type | Required | Kind | Notes |
|---|---|---|---|---|
| `kind` | `z.literal('gate-open')` | Yes | known | Discriminator; the cloud uses this to route open vs. ack. |
| `gateId` | `z.string().min(1)` | Yes | known | Stable identity across the open/ack pair. Cloud upserts by this. |
| `generation` | `z.number().int().nonnegative()` | Yes | known | Monotonic per gateId; used by the cloud to reject stale opens. |
| `scope` | `z.object({ owner, repo, issueNumber })` or similar | Yes | passthrough | Full shape defined in the epic contract; orchestrator only validates presence of `scope`. |
| `openedAt` | `z.string().datetime()` | Yes | known | MCP's clock at open time. Distinct from the relay `timestamp`. |
| `payload` | `z.unknown()` | No | passthrough | Free-form gate content the cloud renders. |

**Zod refinement**: `.strict()` is **not** applied — the orchestrator must forward-compat unknown fields (per the epic's "wire contracts as written" directive). The schema whitelists `kind`, `gateId`, `generation`, `openedAt` structurally and accepts additional fields via a passthrough.

**TS type**: `export type GateOpen = z.infer<typeof GateOpenSchema>;`

### 1.2 `GateAckSchema`

Payload the in-cluster MCP posts to `POST /cockpit/gates/:id/ack` when a gate is acknowledged (answered, timed out, or otherwise resolved). Emitted verbatim on `cluster.cockpit`.

| Field | Type | Required | Kind | Notes |
|---|---|---|---|---|
| `kind` | `z.literal('gate-ack')` | Yes | known | Discriminator. |
| `gateId` | `z.string().min(1)` | Yes | known | Must equal the path param `:id` — orchestrator refuses mismatch. |
| `generation` | `z.number().int().nonnegative()` | Yes | known | Must equal the open's generation for the same gateId. Orchestrator does **not** enforce (cloud does); it validates presence + type only. |
| `outcome` | `z.string().min(1)` or enum | Yes | passthrough | Epic contract defines the enum; orchestrator only validates presence. |
| `ackedAt` | `z.string().datetime()` | Yes | known | MCP's clock at ack time. |
| `answer` | `z.unknown()` | No | passthrough | Optional payload — the operator's answer, if any. |

**Path/body merge**: the route merges `{ gateId: request.params.id }` into the body **before** validation. If the body already carries `gateId`, it must equal the path param; otherwise the schema rejects the request.

**TS type**: `export type GateAck = z.infer<typeof GateAckSchema>;`

### 1.3 `GateAnswerSchema`

Payload the cloud pushes to `POST /cockpit/answers` (relay-proxied). Never emitted on the relay — this is one-way inbound.

| Field | Type | Required | Kind | Notes |
|---|---|---|---|---|
| `kind` | `z.literal('gate-answer')` | Yes | known | Discriminator; guards against misrouted payloads. |
| `deliveryId` | `z.string().min(1)` | Yes | known | Dedup key. Cloud generates once per delivery attempt. |
| `gateId` | `z.string().min(1)` | Yes | known | Corresponds to a prior `GateOpen`; the reader (doorbell) joins on this. |
| `generation` | `z.number().int().nonnegative()` | Yes | known | Same as gate-open's; used by the reader to discard stale answers. |
| `answeredAt` | `z.string().datetime()` | Yes | known | Cloud's clock at answer time. |
| `answer` | `z.unknown()` | Yes | passthrough | Free-form operator-provided answer. |

**TS type**: `export type GateAnswer = z.infer<typeof GateAnswerSchema>;`

## 2. In-memory state

### 2.1 `RetainedCockpitEvents` (`retained-cockpit-events.ts`)

Bounded FIFO of relay events waiting for the relay client to (re)connect.

```typescript
interface RetainedEvent {
  event: 'cluster.cockpit';   // literal — future-proofed for the same module hosting other channels
  data: unknown;              // pre-validated payload (GateOpen | GateAck)
  timestamp: string;          // ISO8601, captured at enqueue time
  approxBytes: number;        // cached JSON.stringify(data).length + fixed overhead
}

interface RetainerCaps {
  maxCount: number;  // default 1000
  maxBytes: number;  // default 4 * 1024 * 1024
}

interface RetainedCockpitEvents {
  enqueue(event: RetainedEvent): { droppedCount: number };
  drainInto(client: ClusterRelayClient): { sent: number; failed: number };
  size(): { count: number; bytes: number };
  clear(): void;
}
```

**Invariants**:
- `count <= maxCount && bytes <= maxBytes` always.
- Overflow: pop from the head (oldest) until under caps. `droppedCount` returned so the route can log once.
- No dedup — the cloud upserts by `gateId`.
- `drainInto` iterates from head to tail, `client.send()` each, stops on first synchronous throw. Sent events are removed atomically. Failed drain leaves the remainder in the queue (retried on next `handleConnected`).
- Module-scope singleton (mirrors `retained-tunnel-event.ts`), but the singleton is constructed with caps in `server.ts` so tests can create their own.

### 2.2 `CockpitAnswersDedup` (embedded in `CockpitAnswersWriter`)

Simple `Set<string>` keyed by `deliveryId`.

```typescript
class CockpitAnswersDedup {
  private set = new Set<string>();
  has(deliveryId: string): boolean;
  add(deliveryId: string): void;
  size(): number;
  reset(): void;  // called on rotation? NO — the set spans rotations for the current run.
}
```

**Notes**:
- **Not** reset on rotation. A rotation just moves lines to `.1`; their `deliveryId`s should still dedup if the cloud re-delivers.
- Reset only on `writer.init()` (boot) — populated from the boot scan.
- Unbounded within a run. Practical ceiling: ~1M entries at ~50 bytes each = ~50 MiB. Rotation of `answers.ndjson` well before that keeps writers healthy; the dedup set at 1M entries is a signal the answers file has grown far past its rotation threshold — investigate rather than trim.

## 3. On-disk state

### 3.1 Answers file family

```
/workspaces/.generacy/cockpit/
├─ answers.ndjson          Current write target. Mode 0644.
├─ answers.ndjson.1        Most recent rotated sibling.
├─ answers.ndjson.2        Older.
└─ answers.ndjson.3        Oldest kept (default N=3).
```

**File format**: newline-delimited JSON. Each line is:

```
JSON.stringify(GateAnswer) + '\n'
```

No headers, no framing bytes. Consumers `readline`-split and `JSON.parse` each line; a malformed line is skipped with a `warn` log (matches the boot scan's tolerance).

**Atomicity**:
- Each append is a **single** `fs.write(fd, buffer)` for the full line including the trailing `\n`. No partial-line writes even under crash — a torn write results in a truncated last line, which readers detect and skip.
- Rotation is `rename()` — atomic on the same filesystem.
- A per-writer async mutex serializes appends and rotations. No two operations run concurrently.

**Fsync policy**: no explicit `fsync` after each append. The answers file is a durability-optional buffer between the cloud and the doorbell; the cloud retries by `deliveryId` on redelivery. Rotation `rename()` is durability-optional as well — the OS will replay the metadata operation on recovery.

**Growth signal**: on each rotation, log `{ event: 'cockpit-answers-rotated', keptSiblings: N }` at `info`. The doorbell tails from `.1` outward on start, so this log corresponds to a doorbell-visible event boundary.

### 3.2 Rotation configuration

| Env var | Default | Notes |
|---|---|---|
| `COCKPIT_ANSWERS_FILE` | `/workspaces/.generacy/cockpit/answers.ndjson` | Full path; parent dir auto-created. |
| `COCKPIT_ANSWERS_ROTATION_BYTES` | `33554432` (32 MiB) | Rotation threshold on current file size. |
| `COCKPIT_ANSWERS_ROTATION_KEEP` | `3` | Number of rotated siblings retained. `.1` through `.N`. |
| `COCKPIT_INTERNAL_API_KEY` | (unset) | If unset, gate routes reject all requests with 401. Startup logs a warn. |
| `COCKPIT_RETAIN_MAX_COUNT` | `1000` | FIFO count cap. |
| `COCKPIT_RETAIN_MAX_BYTES` | `4194304` (4 MiB) | FIFO byte cap. |

## 4. Relationships

```
POST /cockpit/gates ──┐                        ┌─► client.send({event: 'cluster.cockpit',
POST /cockpit/gates   │                        │                 data, timestamp})
      /:id/ack ───────┼─► GateOpen | GateAck ──┤
                      │   (schema.parse)       └─► retainer.enqueue(...)
                      │                            (if !client.isConnected)
                      │
                      └─► shared authMiddleware (COCKPIT_INTERNAL_API_KEY)

relay handleConnected ──► retainer.drainInto(client)
                         (best-effort; leftovers retried next connect)

POST /cockpit/answers ──► GateAnswer ──► dedup.has(deliveryId)?
   (via relay proxy      (schema.parse)    │
    fallback)                              ├─Y: 200 {deduped: true}, no write
                                           └─N: writer.append(line), dedup.add(...)
                                              on rotation: rotate files, retain N siblings
```

## 5. Validation summary

| Payload | Rejects if | Result |
|---|---|---|
| Any of Open/Ack/Answer | Body is not a JSON object | 400 VALIDATION |
| GateOpen | Missing `kind`, `gateId`, `generation`, `openedAt`, `scope`, or wrong types | 400 VALIDATION |
| GateAck | Missing required fields, or `body.gateId !== path.:id` (when body carries gateId) | 400 VALIDATION |
| GateAnswer | Missing `kind`, `deliveryId`, `gateId`, `generation`, `answeredAt`, `answer`, or wrong types | 400 VALIDATION; **nothing written** |
| All | Zod-passthrough fields | Accepted, forwarded/persisted as-is |

The orchestrator is **not** the source of truth for gate semantics; the cloud is. The orchestrator's job is to keep the wire and disk formats well-formed and to guarantee the retain-and-replay + dedup guarantees.
