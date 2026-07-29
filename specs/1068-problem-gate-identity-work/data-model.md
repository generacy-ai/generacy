# Data Model: End-to-end verification of run-scoped gate identity

**Feature**: End-to-end verification of run-scoped gate identity across generacy / generacy-cloud / agency
**Spec**: [spec.md](./spec.md)
**Plan**: [plan.md](./plan.md)
**Date**: 2026-07-29

Entities introduced or extended by this harness. All types live under `packages/orchestrator/src/__tests__/cockpit-gates/` unless noted. External wire schemas are re-used, not redefined (SC-004).

---

## E1: `GateDoc` (fake-cloud-side storage entity)

Represents a gate as it lives inside `FakeCloudStore` — the harness's stand-in for the generacy-cloud Firestore doc under `organizations/{orgId}/cockpitGates/{gateId}`.

```ts
interface GateDoc {
  /** 24-char hex; primary key. */
  gateId: string;
  /** `${issueRef}:${gateType}:${generation}[:${runId}]`. */
  gateKey: string;
  gateType: GateType;                  // from @generacy-ai/cockpit
  issueRef: string;
  epicRef: string;
  /**
   * Present on Phase-A-and-later docs; ABSENT on hand-crafted pre-Phase-A
   * docs (FR-009). The list-mode fallback filters on this: docs without
   * `generation` still surface, they just carry `generation: undefined` in
   * the entry so the render layer knows to substitute a placeholder.
   */
  generation?: string;
  /**
   * Optional per-run discriminator. When present, folded into `gateKey`.
   * FR-008 asserts a cluster that OMITS this field still round-trips.
   */
  runId?: string;
  issueTitle: string;
  issueUrl: string;
  title: string;
  body: string;
  options: GateOption[];               // from @generacy-ai/cockpit
  allowFreeText: boolean;
  sessionId: string;
  askedAt: string;                     // ISO-8601
  /** Cloud-level 7-state status, set by store transitions. */
  status:
    | 'open'
    | 'answered'
    | 'delivered'
    | 'applied'
    | 'superseded'
    | 'failed'
    | 'expired';
  /** Latest outcome, when the doc has been ack'd. */
  lastOutcome?: {
    outcome: 'applied' | 'superseded' | 'failed';
    detail?: string;
    at: string;                        // ISO-8601
  };
}
```

**Validation**:
- `gateId.length === 24` (matches `GateOpenWireSchema.gateId: z.string().length(24)`).
- `gateKey === deriveGateKey(issueRef, gateType, String(generation), runId)` (D-5: fake uses the same helper the cluster uses).
- `status` transitions monotonic in the direction the cloud allows: `open → answered → delivered → applied` (happy path); terminals `superseded | failed | expired` are absorbing.

**Relationships**:
- Written when `FakePeer` accepts a validated `gate-open` frame (D-8, hooked into `fake-peer.ts` payload-validator success path).
- Updated when `FakePeer` accepts a validated `gate-outcome` frame (`applyOutcome(gateId, outcome)`).
- Read by the fake HTTP handler backing `CloudGateQueryClient` (D-6).

---

## E2: `FakeCloudStore` (fake-cloud storage service)

In-memory `Map<gateId, GateDoc>` with the six methods `CloudGateQueryClient` needs plus the ingest hooks the fake peer uses.

```ts
interface FakeCloudStoreOptions {
  /**
   * When `false`, `putGateFromWireFrame` drops the `generation` field before
   * storing (Phase A revert simulation, `contracts/revert-scenarios.md`).
   * Default: true.
   */
  persistGeneration?: boolean;
}

interface FakeCloudStore {
  /** Ingest a validated cluster.cockpit gate-open frame payload. */
  putGateFromWireFrame(payload: GateOpenWire): void;
  /** Ingest a validated cluster.cockpit gate-outcome frame payload. */
  applyOutcome(gateId: string, outcome: GateOutcome, detail?: string): void;
  /** Direct-write for FR-009 (hand-crafted pre-Phase-A doc). */
  putRaw(doc: GateDoc): void;
  /** Read for status mode. Returns null if not found. */
  getByKey(
    issueRef: string,
    gateType: GateType,
    generation: string | number,
    runId?: string,
  ): GateDoc | null;
  /** Read for list mode. Returns all non-terminal docs matching (issueRef[, gateType]). */
  listByIssueRef(issueRef: string, gateType?: GateType): GateDoc[];
  /** Test-only inspection. */
  readonly all: ReadonlyArray<GateDoc>;
}
```

**Invariants**:
- `getByKey` uses `deriveGateKey` from `@generacy-ai/cockpit` internally — same helper the cluster's `cockpit_gate_open` uses. Guards D-5.
- Store is per-scenario (constructed inside `setupScenario`); cleared in `ctx.cleanup`.
- `putRaw` bypasses `deriveGateKey` — FR-009 needs a doc whose `gateKey` might not be derivable from the fields (no `generation`).

---

## E3: `FakePeer` payload-violation tracker (extension of E1024 fake peer)

Extends the existing `FakePeer` interface in `fake-peer.ts`:

```ts
interface FakePeer {
  // ... existing fields (url, received, waitForEvent, sendApiRequest, ...) ...

  /** #1068 — payload-validator violations on cluster.cockpit frames. */
  readonly payloadViolations: ReadonlyArray<{
    frameType: 'gate-open' | 'gate-outcome' | 'unknown';
    gateId?: string;
    issues: unknown; // ZodError.issues shape
  }>;
}
```

**Populated by**: extension to `fake-peer.ts`'s `ws.on('message', ...)` handler (§plan.md § Approach 1). On a `msg.event === 'cluster.cockpit'` frame:
1. If `msg.data.type === 'gate-open'` → `GateOpenWireSchema.safeParse(msg.data)`.
2. If `msg.data.type === 'gate-outcome'` → `GateOutcomeWireSchema.safeParse(msg.data)`.
3. Failure → push to `payloadViolations`, do NOT push to `received.events`, do NOT crash.

**Contract**: happy-path scenarios assert `peer.payloadViolations.length === 0`. FR-006 negative scenario deliberately drifts a body (drops `askedAt`), asserts `payloadViolations.length === 1`. See `contracts/fake-peer-payload-schema.md`.

---

## E4: `McpToolDriver` (Q2=C direct-import wrapper)

Thin wrapper around the four MCP tool handlers. Exists to (a) hide the `BuildMcpServerDeps` plumbing in one place, (b) centralize the workspace-cycle fallback if D-2-b becomes necessary.

```ts
interface McpToolDriverOptions {
  /** Light-orchestrator base URL from `ScenarioContext.orchestratorUrl`. */
  baseUrl: string;
  /** Injected `fetch` — default `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

interface McpToolDriver {
  gateOpen(input: GateOpenInput): Promise<ToolResult<{ gateId: string; status: 'open' }>>;
  gateAck(input: GateAckInput): Promise<ToolResult<Record<string, unknown>>>;
  gateStatus(input: CockpitGateStatusInput): Promise<ToolResult<CockpitGateStatusData>>;
  gateList(input: CockpitGateListInput): Promise<ToolResult<CockpitGateListData>>;
}

function createMcpToolDriver(opts: McpToolDriverOptions): McpToolDriver;
```

**Implementation**: each method delegates to the named handler:

```ts
gateStatus: (input) => cockpitGateStatus(input, { baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl ?? fetch })
```

**`BuildMcpServerDeps` shape** — from `packages/generacy/src/cli/commands/cockpit/mcp/server.ts`. The relevant fields for the query tools are `baseUrl` + `fetchImpl`; write tools take the same shape via `resolveGateOptions`.

---

## E5: `ScenarioContext` extension (extends #1024 shape)

Adds two optional fields on the existing `ScenarioContext` in `scenario-helpers.ts`:

```ts
interface ScenarioContext {
  // ... existing (peer, doorbell, orchestrator, relayClient, answersFilePath, tempDir, orchestratorUrl, epicRef, cleanup) ...

  /** #1068 — set when `setupScenario({ startFakeCloud: true })` is used. */
  fakeCloud: FakeCloudStore | null;
  /** #1068 — set when `startFakeCloud: true`. */
  mcp: McpToolDriver | null;
  /** #1068 — captured `'cockpit gate emitted'` log lines from the light orchestrator (FR-004). */
  gateEmittedLogLines: ReadonlyArray<{ gateId: string; type: string }>;
}
```

**Setup ordering** (new inside `setupScenario`, guarded by `opts.startFakeCloud`):
1. `fakeCloud = createFakeCloudStore({ persistGeneration: opts.persistGeneration ?? true })`.
2. Wire `fakeCloud.putGateFromWireFrame` / `applyOutcome` into `fake-peer.ts`'s payload-validator success path (per E3).
3. Construct `CloudGateQueryClient` via `createCloudGateQueryClient({ clusterId: 'test-cluster', httpRequestImpl: buildFakeCloudHttpImpl(fakeCloud) })`.
4. Pass `getCloudGateQueryClient: () => cloudGateQueryClient` into `setupCockpitGatesRoute` (existing option on the route).
5. Swap `SILENT_LOGGER` for a `CountingLogger` that captures every `info` call with message `'cockpit gate emitted'` into `gateEmittedLogLines`.
6. `mcp = createMcpToolDriver({ baseUrl: orchestratorUrl, fetchImpl: fetch })`.

**Cleanup**: `fakeCloud`, `mcp`, and `gateEmittedLogLines` are garbage-collected with the context; no additional teardown.

---

## E6: `CountingLogger`

Test-only replacement for `SILENT_LOGGER` that captures structured log lines by message.

```ts
interface CountingLogger {
  info(msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  /** Structured log records, oldest-first. */
  readonly records: ReadonlyArray<{
    level: 'info' | 'warn' | 'error' | 'debug';
    obj?: Record<string, unknown>;
    msg: string;
  }>;
}
```

**Used for**:
- FR-004: assert exactly one record per `gateId` with `msg === 'cockpit gate emitted'`.
- FR-007: assert zero records with `msg.includes('Invalid relay message, skipping')`.

---

## Type re-use summary (no redefinition)

| Type | Source | Used by |
|------|--------|---------|
| `GateType`, `GateOutcome`, `GateOption` | `@generacy-ai/cockpit` | E1, E2, E3 |
| `GateOpenWireSchema`, `GateOutcomeWireSchema` | `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` (or `@generacy-ai/cockpit` per D-3) | E3 |
| `GateOpenInput`, `GateAckInput` | `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` | E4 |
| `CockpitGateStatusInput`, `CockpitGateStatusData`, `CockpitGateListInput`, `CockpitGateListData` | `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts` | E4 |
| `deriveGateKey`, `deriveGateId` | `@generacy-ai/cockpit` (fixture-builder module) | E1 (validation), E2 (invariant), test bodies (independent derivation) |
| `CloudGateQueryClient`, `createCloudGateQueryClient`, `HttpsRequestImpl` | `packages/orchestrator/src/services/cloud-gate-query-client.ts` | E5 (fake HTTP shim target) |
| `RelayMessageSchema` | `@generacy-ai/cluster-relay` | E3 (existing envelope check, unchanged) |
| `ClusterRelayClient` | `@generacy-ai/cluster-relay` | E5 (existing) |

## Anti-types (things this feature deliberately does NOT define)

- **No `GateDocRepository` interface.** `FakeCloudStore` IS the repo; it doesn't abstract over Firestore.
- **No `MockRelayClient`.** Explicitly banned by FR-001; the real `ClusterRelayClient` connects to the real fake peer.
- **No `SimulatePhaseAConfig`.** Explicitly banned by FR-012; the revert switch is fake-side (`FakeCloudStoreOptions.persistGeneration`), not a `SIMULATE_PHASE_*` env var.
- **No `EchoPeer` / `vi.fn()` peer.** Explicitly banned by US5; only the real `WebSocketServer` fake peer.
