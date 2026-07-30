# Quickstart: End-to-end verification of run-scoped gate identity

**Feature**: #1068 | **Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)
**Audience**: implementers on the feature branch and reviewers verifying the harness locally.

This harness runs entirely inside `pnpm --filter @generacy-ai/orchestrator test`. No Docker, no live cloud, no live GitHub, no smee — see `contracts/fake-cloud-store.md` for the fake surface.

## Preconditions

**Local (all must hold to run the harness meaningfully — but the tests themselves can execute without them; they will just no-op on real-cluster checks)**:

- Node.js ≥ 22 (workspace root `.nvmrc`).
- `pnpm install` from repo root completed.
- Sibling tests pass: `pnpm --filter @generacy-ai/orchestrator test cockpit-gates-integration.integration.test.ts` (verifies the #1024 scaffolding this feature extends).

**End-to-end semantic preconditions (from spec §Preconditions — apply when running against a real cluster, not needed for this harness):**

- generacy-cloud Phase A deployed: cloud gate doc stores `generation`; `deriveGateKey` accepts `runId` on both write and read paths.
- generacy Phase B released and cluster running it: `runId` threaded through the four MCP tools.
- agency Phase C released: `/cockpit:auto` passes `runId`.
- Cluster on new build; **workers restarted after cluster update** (FR-011). `generacy update` is image-digest-based and does not re-pull `@channel` npm packages — restart the orchestrator entrypoint AND the worker processes, otherwise new package code sits stale in worker memory.

## Running the harness

```bash
# All 1068 harness tests:
pnpm --filter @generacy-ai/orchestrator test cockpit-gates-runid.integration.test.ts

# Single FR:
pnpm --filter @generacy-ai/orchestrator test cockpit-gates-runid.integration.test.ts -- -t "FR-003"

# With verbose logging (see the light-orchestrator log records):
DEBUG_HARNESS=1 pnpm --filter @generacy-ai/orchestrator test cockpit-gates-runid.integration.test.ts
```

**Expected local runtime**: 30–60 s (SC-006 budget: 90 s median / 180 s p95). Sibling `relay-integration.integration.test.ts` runs in ~15–25 s as a lower-bound reference.

## What the harness composes

Every scenario builds the same real cluster-side surface end-to-end:

```
                                                         ┌────────────────────┐
Vitest test body ──▶ McpToolDriver ──▶ Light orchestrator│                    │
  (direct import)   (Q2=C wrapper)      (real routes)   │  ClusterRelayClient│──▶ FakePeer (WebSocketServer)
                                                         │  (real)            │      │
                                                         └────────────────────┘      │
                                                                 │                    ▼
                                                        HTTP: GET /cockpit/gates   FakeCloudStore
                                                                 │                (Map<gateId, GateDoc>)
                                                                 ▼                    ▲
                                                        CloudGateQueryClient──────────┘
                                                        (real, with fake HTTP shim
                                                         via httpRequestImpl seam)
```

Only two components are fake: the WebSocket peer (real `ws.WebSocketServer`, fake protocol behaviour — accepts frames, validates payloads with the frozen wire schemas, hands them to the store) and the cloud HTTP endpoint (a `httpRequestImpl` closure returning JSON derived from `FakeCloudStore`). Everything the cluster ships is real code.

## Scenario cookbook

### FR-002 — re-run makes a distinct gate

```ts
const runIdA = 'rid-run-a';
const runIdB = 'rid-run-b';
const commonArgs = {
  issueRef: 'owner/repo#42',
  gateType: 'phase-queue' as const,
  generation: 'P2',
  epicRef: 'owner/repo#42',
  issueTitle: 'Test',
  issueUrl: 'https://github.com/owner/repo/issues/42',
  title: 'Approve P2?',
  body: 'Approve moving to phase 2.',
  sessionId: 'sess-1068',
};

// Run A: open → ack applied
const openA = await ctx.mcp!.gateOpen({ ...commonArgs, runId: runIdA });
expect(openA.status).toBe('ok');
await ctx.mcp!.gateAck({ gateId: openA.data.gateId, outcome: 'applied' });

// Run B: re-open same natural gate
const openB = await ctx.mcp!.gateOpen({ ...commonArgs, runId: runIdB });
expect(openB.status).toBe('ok');
expect(openB.data.gateId).not.toBe(openA.data.gateId);
```

### FR-003 — status returns `open` in-run

```ts
const open = await ctx.mcp!.gateOpen({ ...commonArgs, runId: 'rid-x' });
// Poll — the emit to the peer is fire-and-forget (async).
await waitFor(() => ctx.fakeCloud!.getByKey(commonArgs.issueRef, 'phase-queue', 'P2', 'rid-x') !== null);

const status = await ctx.mcp!.gateStatus({
  issueRef: commonArgs.issueRef,
  gateType: 'phase-queue',
  generation: 'P2',
  runId: 'rid-x',
});
expect(status.status).toBe('ok');
expect(status.data.status).toBe('open');
expect(status.data.gateId).toBe(open.data.gateId);
```

### FR-004 — no re-emit across ≥3 wakes

```ts
const open = await ctx.mcp!.gateOpen({ ...commonArgs, runId: 'rid-wakes' });
for (let wake = 1; wake <= 3; wake++) {
  const status = await ctx.mcp!.gateStatus({
    issueRef: commonArgs.issueRef,
    gateType: 'phase-queue',
    generation: 'P2',
    runId: 'rid-wakes',
  });
  expect(status.status).toBe('ok');
  expect(['open', 'answered']).toContain(status.data.status);
}

// Exactly one frame at the peer for this gateId.
const frames = ctx.peer.received.events.filter(
  (e) => e.event === 'cluster.cockpit' &&
         (e.data as { gateId?: string; type?: string }).type === 'gate-open' &&
         (e.data as { gateId?: string }).gateId === open.data.gateId,
);
expect(frames).toHaveLength(1);

// Exactly one 'cockpit gate emitted' log line for this gateId.
const logs = ctx.gateEmittedLogLines.filter((l) => l.gateId === open.data.gateId);
expect(logs).toHaveLength(1);
```

### FR-008 — cluster without Phase B (omit `runId`)

```ts
// Note: no `runId` field. Same tool call shape a pre-Phase-B build would emit.
const open = await ctx.mcp!.gateOpen({ ...commonArgs }); // no runId
expect(open.status).toBe('ok');
await ctx.mcp!.gateAck({ gateId: open.data.gateId, outcome: 'applied' });

const doc = ctx.fakeCloud!.getByKey(commonArgs.issueRef, 'phase-queue', 'P2', undefined);
expect(doc?.status).toBe('applied');
```

### FR-009 — pre-Phase-A doc (no `generation`)

```ts
// Direct-write bypassing derivation. Doc has NO generation field.
ctx.fakeCloud!.putRaw({
  gateId: gid('c1a55'),
  gateKey: 'owner/repo#42:phase-queue', // no generation segment
  gateType: 'phase-queue',
  issueRef: 'owner/repo#42',
  epicRef: 'owner/repo#42',
  // generation: undefined — deliberately absent
  issueTitle: 'Old',
  issueUrl: 'https://github.com/owner/repo/issues/42',
  title: 'Old gate',
  body: '...',
  options: [],
  allowFreeText: true,
  sessionId: 'sess-old',
  askedAt: '2026-01-01T00:00:00Z',
  status: 'open',
});

const list = await ctx.mcp!.gateList({ issueRef: 'owner/repo#42' });
expect(list.status).toBe('ok');
const entry = list.data.gates.find((g) => g.gateId === gid('c1a55'));
expect(entry).toBeDefined();
expect(entry!.generation).toBe('<pre-phase-a>'); // fallback sentinel
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `FR-003` fails with `status: 'absent'` on the healthy cell | `FakeCloudStore.getByKey` derivation drifted from cluster `deriveGateKey` (D-5 violation) | Confirm the fake calls the same `deriveGateKey` from `@generacy-ai/cockpit` the tool uses. |
| `FR-006` fails with `frameId` byte-mismatch | Wire body's `frameId` was minted twice — once in the tool, once in the route | Check `packages/orchestrator/src/routes/cockpit-gates.ts:340`: route mints only when `parsed.frameId === undefined`. |
| Every test fails with `Cannot find module '.../cockpit_gate_open.js'` | D-2-a (direct import) resolver mismatch | Fall back to D-2-b (subprocess). See [contracts/mcp-tool-driver.md § Implementation](./contracts/mcp-tool-driver.md). |
| `no-simulate-phase-in-src.test.ts` fails | Someone slipped a `SIMULATE_PHASE_*` env var into `src/` | Revert; realize the fault injection in fake-side configuration per `contracts/revert-scenarios.md`. |
| Runtime > 90 s locally | Reconnect delay too high; retry backoff too aggressive; missing per-test cleanup | Check `setupScenario({ relayReconnectMs: 200 })` (default) — do not raise. Confirm `afterEach` calls `ctx.cleanup()`. |
| `payloadViolations.length > 0` on a happy-path test | Wire body drift between cluster-side mirror and `@generacy-ai/cockpit` fixture | Re-run `pnpm --filter @generacy-ai/cockpit build`; if still failing, this is a real drift bug — file against the mirror that broke. |
| `cockpit_gate_list` returns entry with `generation: '<pre-phase-a>'` on the healthy cell | `FakeCloudStore` was constructed with `persistGeneration: false` | Check `setupScenario()` opts; the option defaults to `true`. |

## Where to look

| Question | File |
|----------|------|
| How does the fake peer validate payloads? | `contracts/fake-peer-payload-schema.md` |
| How does the fake cloud store gates? | `contracts/fake-cloud-store.md` |
| How does the harness drive MCP tools? | `contracts/mcp-tool-driver.md` |
| Why can't we ship a `SIMULATE_PHASE_A=1` env var? | `contracts/production-code-boundary.md` |
| What does each phase revert actually break? | `contracts/revert-scenarios.md` |
| What's the shape of a `GateDoc`? | `data-model.md § E1` |
| Why direct import instead of MCP protocol? | `research.md § Q2=C`, `research.md § D-2` |
| Why fake HTTP cloud instead of real container? | `research.md § Q1=A`, `research.md § D-6` |

## Next step

`/tasks` — generate the dependency-ordered task list from this plan.
