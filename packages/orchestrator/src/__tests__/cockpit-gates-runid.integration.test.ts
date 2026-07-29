/**
 * End-to-end verification of run-scoped gate identity (#1068).
 *
 * Extends the #1024 / #1077 cockpit-gates harness to compose the four MCP gate
 * tools (real `cockpit_gate_open` / `cockpit_gate_ack` / `cockpit_gate_status` /
 * `cockpit_gate_list` handlers, imported directly per Q2=C), the real
 * orchestrator gate routes, the real `ClusterRelayClient`, and a
 * `FakeCloudStore`-backed `CloudGateQueryClient` end-to-end. Seven FR
 * verification items pin the composed run-scoped-gate contract that spans
 * generacy Phase B, generacy-cloud Phase A and agency Phase C.
 *
 * SC-004: every wire body constructed through fixture builders (or, for
 * FR-005's colon-bearing generation and FR-009's pre-Phase-A doc, hand-crafted
 * with explicit rationale in the test body). No inline schema literals.
 *
 * Revert matrix per contracts/revert-scenarios.md § CI matrix realization —
 * three cells: `healthy`, `phase-A-reverted`, `phase-B-reverted`. Phase-C is
 * assertion-identical to Phase-B and is omitted to keep CI cost bounded (the
 * attribution boundary lives outside this harness — in agency's
 * playbook-verification.test.ts).
 *
 * FR-006, FR-007, FR-010, FR-011 (test-isolation and pre-condition items) live
 * in the `healthy path only` block since they do not vary across revert cells.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  deriveGateId,
  deriveGateKey,
  type GateType,
} from '@generacy-ai/cockpit';
import {
  setupScenario,
  waitFor,
  type ScenarioContext,
} from './cockpit-gates/scenario-helpers.js';
import type { GateDoc } from './cockpit-gates/fake-cloud-store.js';

/** 24-char hex gate id from a short hex tag (test correlation only). */
const gid = (hexTag: string): string => hexTag.padEnd(24, '0');

/**
 * Common `cockpit_gate_open` semantic input. Test bodies override just the
 * discriminating fields (`generation`, `runId`, `sessionId`, …).
 */
function commonOpenInput() {
  return {
    issueRef: 'owner/repo#42',
    gateType: 'phase-queue' as const,
    generation: 'P2' as string,
    epicRef: 'owner/repo#42',
    issueTitle: 'Test issue for #1068',
    issueUrl: 'https://github.com/owner/repo/issues/42',
    title: 'Approve P2?',
    body: 'Approve moving to phase 2.',
    options: [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ],
    allowFreeText: true,
    sessionId: 'sess-1068',
  };
}

/** Assert-and-unwrap a `ToolResult<T>`; fails the test on `status === 'error'`. */
function unwrap<T>(result: { status: string; data?: T; class?: string; detail?: string }): T {
  if (result.status !== 'ok') {
    throw new Error(
      `expected ok result, got error: class=${result.class ?? '?'} detail=${result.detail ?? '?'}`,
    );
  }
  return result.data as T;
}

// ---------------------------------------------------------------------------
// SC-002 revert matrix — 3 cells (phase-C omitted; assertion-identical to B).
// ---------------------------------------------------------------------------

type RevertCell = {
  label: 'healthy' | 'phase-A-reverted' | 'phase-B-reverted';
  opts: {
    fakeCloudOptions?: { persistGeneration?: boolean };
    /** #1068 — Phase-B revert: omit runId on every MCP call. Fake-side config
     *  only; no `SIMULATE_PHASE_B` env var (FR-012). */
    omitRunId?: boolean;
  };
};

const REVERT_CELLS: RevertCell[] = [
  { label: 'healthy', opts: {} },
  { label: 'phase-A-reverted', opts: { fakeCloudOptions: { persistGeneration: false } } },
  { label: 'phase-B-reverted', opts: { omitRunId: true } },
];

describe.each(REVERT_CELLS)('#1068 SC-002 revert matrix: $label', (cell) => {
  let ctx: ScenarioContext;

  beforeEach(async () => {
    ctx = await setupScenario({
      startFakeCloud: true,
      ...(cell.opts.fakeCloudOptions !== undefined
        ? { fakeCloudOptions: cell.opts.fakeCloudOptions }
        : {}),
    });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------------
  // FR-002 — re-run makes a new gate
  // -------------------------------------------------------------------------
  it('FR-002: two runs with distinct runIds mint two distinct gateIds', async () => {
    const args = commonOpenInput();

    // Run A: open → ack applied
    const runIdA = cell.opts.omitRunId ? undefined : 'rid-run-a';
    const openA = unwrap(
      await ctx.mcp!.gateOpen({
        ...args,
        ...(runIdA !== undefined ? { runId: runIdA } : {}),
      }),
    );
    expect(openA.status).toBe('open');
    // Wait on peer-side frame receipt: works under all cells (Phase-A revert
    // deliberately makes getByKey miss, so we can't wait on that).
    await waitFor(
      () =>
        ctx.peer.received.events.some(
          (e) =>
            e.event === 'cluster.cockpit' &&
            (e.data as { gateId?: string }).gateId === openA.gateId,
        ),
      3000,
      'expected first gate-open frame to reach peer',
    );
    unwrap(
      await ctx.mcp!.gateAck({
        gateId: openA.gateId,
        outcome: 'applied',
      }),
    );

    // Run B: same natural gate, distinct runId
    const runIdB = cell.opts.omitRunId ? undefined : 'rid-run-b';
    const openB = unwrap(
      await ctx.mcp!.gateOpen({
        ...args,
        ...(runIdB !== undefined ? { runId: runIdB } : {}),
      }),
    );

    if (cell.label === 'phase-B-reverted') {
      // FR-002 (Phase B reverted): re-run collides with terminal-state applied gate.
      // Both derivations produce the same gateId; the fake cloud upsert-overwrites
      // and the tool re-derives the same id.
      expect(openB.gateId).toBe(openA.gateId);
      return;
    }

    // Healthy + Phase-A-reverted: distinct gateIds by derivation.
    expect(openB.gateId).not.toBe(openA.gateId);

    // Peer must have received two distinct gate-open frames.
    await waitFor(
      () =>
        ctx.peer.received.events.some(
          (e) =>
            e.event === 'cluster.cockpit' &&
            (e.data as { gateId?: string }).gateId === openB.gateId,
        ),
      3000,
      'expected second gate-open frame to reach peer',
    );
    const frames = ctx.peer.received.events.filter(
      (e) =>
        e.event === 'cluster.cockpit' &&
        (e.data as { type?: string; gateId?: string }).type === 'gate-open' &&
        ((e.data as { gateId?: string }).gateId === openA.gateId ||
          (e.data as { gateId?: string }).gateId === openB.gateId),
    );
    // #1053: `gateOpen` is idempotent per (natural gate, runId); the ack cycle
    // between run A and run B does NOT introduce extra frames.
    expect(frames.length).toBe(2);

    if (cell.label === 'healthy') {
      // Only the healthy cell exercises the generation-scoped lookup.
      const docA = ctx.fakeCloud!.getByKey(args.issueRef, args.gateType, args.generation, runIdA);
      const docB = ctx.fakeCloud!.getByKey(args.issueRef, args.gateType, args.generation, runIdB);
      expect(docA?.gateId).toBe(openA.gateId);
      expect(docB?.gateId).toBe(openB.gateId);
    }
  });

  // -------------------------------------------------------------------------
  // FR-003 — `cockpit_gate_status(runId)` returns `open` in-run
  // -------------------------------------------------------------------------
  it('FR-003: gate-status(runId) returns open with matching gateId in-run', async () => {
    const args = commonOpenInput();
    const runId = cell.opts.omitRunId ? undefined : 'rid-x';

    const open = unwrap(
      await ctx.mcp!.gateOpen({
        ...args,
        ...(runId !== undefined ? { runId } : {}),
      }),
    );
    // Wait for the frame to reach the peer (works under all cells).
    await waitFor(
      () =>
        ctx.peer.received.events.some(
          (e) =>
            e.event === 'cluster.cockpit' &&
            (e.data as { gateId?: string }).gateId === open.gateId,
        ),
      3000,
      'expected gate-open frame to reach peer',
    );

    const status = await ctx.mcp!.gateStatus({
      issueRef: args.issueRef,
      gateType: args.gateType,
      generation: args.generation,
      ...(runId !== undefined ? { runId } : {}),
    });

    if (cell.label === 'phase-A-reverted') {
      // Cloud does not persist `generation` → fake store's `getByKey` misses.
      expect(status.status).toBe('ok');
      const data = unwrap(status);
      expect(data.status).toBe('absent');
      return;
    }

    expect(status.status).toBe('ok');
    const data = unwrap(status);
    expect(data.status).toBe('open');
    expect(data.gateId).toBe(open.gateId);

    // Also list-mode: the same entry surfaces.
    const list = unwrap(
      await ctx.mcp!.gateList({ issueRef: args.issueRef }),
    );
    expect(list.gates.map((g) => g.gateId)).toContain(open.gateId);
  });

  // -------------------------------------------------------------------------
  // FR-005 — rendering strips `runId` from generation
  // -------------------------------------------------------------------------
  it('FR-005: list entries carry the input generation byte-for-byte', async () => {
    const args = commonOpenInput();

    // Two gates with distinct, sample generations. One is colon-bearing to
    // catch parse-back regressions on the render layer.
    const gen1 = 'P2';
    const gen2 = 'artifact-review:spec-review:abc123';

    const runId1 = cell.opts.omitRunId ? undefined : 'rid-1';
    const runId2 = cell.opts.omitRunId ? undefined : 'rid-2';

    const open1 = unwrap(
      await ctx.mcp!.gateOpen({
        ...args,
        gateType: 'phase-queue' as const,
        generation: gen1,
        ...(runId1 !== undefined ? { runId: runId1 } : {}),
      }),
    );
    const open2 = unwrap(
      await ctx.mcp!.gateOpen({
        ...args,
        gateType: 'artifact-review' as const,
        generation: gen2,
        ...(runId2 !== undefined ? { runId: runId2 } : {}),
      }),
    );

    await waitFor(
      () => ctx.fakeCloud!.all.length >= 2,
      3000,
      'expected two docs in fake cloud',
    );

    const list = unwrap(await ctx.mcp!.gateList({ issueRef: args.issueRef }));
    const entry1 = list.gates.find((g) => g.gateId === open1.gateId);
    const entry2 = list.gates.find((g) => g.gateId === open2.gateId);
    expect(entry1).toBeDefined();
    expect(entry2).toBeDefined();

    if (cell.label === 'phase-A-reverted') {
      // Fallback sentinel — the fake dropped `generation`, so the HTTP shim
      // substitutes the pre-phase-a marker per contracts/fake-cloud-store.md.
      expect(entry1!.generation).toBe('<pre-phase-a>');
      expect(entry2!.generation).toBe('<pre-phase-a>');
      return;
    }

    // Healthy + phase-B-reverted: byte-for-byte round trip.
    expect(entry1!.generation).toBe(gen1);
    // For phase-B-reverted, no runId is passed, so the wire's gateKey has
    // exactly `${issueRef}:${gateType}:${generation}` and the extractor
    // returns generation verbatim. Under healthy, the runId side channel
    // strips the trailing runId. Both should match `gen2`.
    expect(entry2!.generation).toBe(gen2);
  });

  // -------------------------------------------------------------------------
  // FR-008 — cluster without Phase B (omit `runId`)
  // -------------------------------------------------------------------------
  it('FR-008: gate-open + gate-ack round-trip WITHOUT runId', async () => {
    const args = commonOpenInput();

    // Deliberately no `runId` — matches a pre-Phase-B build.
    const open = unwrap(await ctx.mcp!.gateOpen({ ...args }));
    expect(open.status).toBe('open');

    await waitFor(
      () =>
        ctx.peer.received.events.some(
          (e) =>
            e.event === 'cluster.cockpit' &&
            (e.data as { gateId?: string }).gateId === open.gateId,
        ),
      3000,
      'expected gate-open frame to reach peer',
    );

    unwrap(
      await ctx.mcp!.gateAck({
        gateId: open.gateId,
        outcome: 'applied',
      }),
    );

    // Wait for the gate-outcome frame to reach the peer + be applied.
    await waitFor(
      () => {
        const doc = ctx.fakeCloud!.all.find((d) => d.gateId === open.gateId);
        return doc?.status === 'applied';
      },
      3000,
      'expected outcome applied to reach fake cloud',
    );

    // Under healthy + phase-B-reverted (persistGeneration: true), the
    // generation-scoped lookup should also confirm the terminal.
    if (cell.label !== 'phase-A-reverted') {
      const doc = ctx.fakeCloud!.getByKey(
        args.issueRef,
        args.gateType,
        args.generation,
        undefined,
      );
      expect(doc?.status).toBe('applied');
    }
  });

  // -------------------------------------------------------------------------
  // FR-009 — pre-Phase-A doc (no `generation`)
  // -------------------------------------------------------------------------
  it('FR-009: hand-crafted pre-Phase-A doc surfaces with <pre-phase-a> sentinel', async () => {
    const args = commonOpenInput();
    const preId = gid('c1a55');
    // Direct-write into the fake cloud — bypasses derivation deliberately.
    const preDoc: GateDoc = {
      gateId: preId,
      gateKey: `${args.issueRef}:${args.gateType}`, // no generation segment
      gateType: args.gateType,
      issueRef: args.issueRef,
      epicRef: args.epicRef,
      // generation: undefined — deliberately absent (Q3=C hand-crafted)
      issueTitle: 'Old',
      issueUrl: args.issueUrl,
      title: 'Old gate',
      body: '...',
      options: [],
      allowFreeText: true,
      sessionId: 'sess-old',
      askedAt: '2026-01-01T00:00:00Z',
      status: 'open',
    };
    ctx.fakeCloud!.putRaw(preDoc);

    const list = unwrap(await ctx.mcp!.gateList({ issueRef: args.issueRef }));
    const entry = list.gates.find((g) => g.gateId === preId);
    expect(entry).toBeDefined();
    expect(entry!.generation).toBe('<pre-phase-a>');
  });
});

// ---------------------------------------------------------------------------
// Healthy-path-only block — FRs whose assertions do not vary across cells.
// (FR-004 dedup is independent of runId; FR-006 frameId is orthogonal; FR-007
// log line is orthogonal.)
// ---------------------------------------------------------------------------

describe('#1068 healthy path only', () => {
  let ctx: ScenarioContext;

  beforeEach(async () => {
    ctx = await setupScenario({ startFakeCloud: true });
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // -------------------------------------------------------------------------
  // FR-004 — N≥3 wakes, no re-emit
  // -------------------------------------------------------------------------
  it('FR-004: 3 wakes of gate-status observe status ∈ {open, answered}; exactly one frame and one log line', async () => {
    const args = commonOpenInput();
    const runId = 'rid-wakes';

    const open = unwrap(await ctx.mcp!.gateOpen({ ...args, runId }));
    await waitFor(
      () => ctx.fakeCloud!.getByKey(args.issueRef, args.gateType, args.generation, runId) != null,
      3000,
      'expected gate-open frame to reach fake cloud',
    );

    for (let wake = 1; wake <= 3; wake += 1) {
      const status = unwrap(
        await ctx.mcp!.gateStatus({
          issueRef: args.issueRef,
          gateType: args.gateType,
          generation: args.generation,
          runId,
        }),
      );
      expect(['open', 'answered']).toContain(status.status);
    }

    // Exactly one gate-open frame at the peer for this gateId.
    const frames = ctx.peer.received.events.filter(
      (e) =>
        e.event === 'cluster.cockpit' &&
        (e.data as { type?: string; gateId?: string }).type === 'gate-open' &&
        (e.data as { gateId?: string }).gateId === open.gateId,
    );
    expect(frames.length).toBe(1);

    // Exactly one 'cockpit gate emitted' log line for this gateId.
    const logs = ctx.gateEmittedLogLines.filter((l) => l.gateId === open.gateId);
    expect(logs.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // FR-006 — `frameId` correlated over real socket
  // -------------------------------------------------------------------------
  it('FR-006: route-returned frameId byte-equals the peer-received data.frameId', async () => {
    const args = commonOpenInput();

    // Direct HTTP POST so we can observe the route's `frameId` in the response.
    const wire = {
      // Derive gateId/gateKey the way the tool would — this route validates
      // the frozen `GateOpenSchema`.
      type: 'gate-open' as const,
      gateId: deriveGateId(deriveGateKey(args.issueRef, args.gateType, args.generation, 'rid-fid')),
      gateKey: deriveGateKey(args.issueRef, args.gateType, args.generation, 'rid-fid'),
      gateType: args.gateType,
      epicRef: args.epicRef,
      issueRef: args.issueRef,
      issueTitle: args.issueTitle,
      issueUrl: args.issueUrl,
      title: args.title,
      body: args.body,
      options: args.options,
      allowFreeText: args.allowFreeText,
      sessionId: args.sessionId,
      askedAt: new Date().toISOString(),
    };

    const res = await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(wire),
    });
    expect(res.status).toBe(202);
    const bodyJson = (await res.json()) as { frameId?: string; accepted?: boolean };
    expect(typeof bodyJson.frameId).toBe('string');
    const frameId = bodyJson.frameId!;

    await waitFor(
      () =>
        ctx.peer.received.events.some(
          (e) =>
            e.event === 'cluster.cockpit' &&
            (e.data as { gateId?: string }).gateId === wire.gateId,
        ),
      3000,
      'expected peer to receive the gate-open frame',
    );

    const frame = ctx.peer.received.events.find(
      (e) =>
        e.event === 'cluster.cockpit' &&
        (e.data as { gateId?: string }).gateId === wire.gateId,
    )!;
    const peerFrameId = (frame.data as { frameId?: string }).frameId;
    expect(peerFrameId).toBe(frameId);

    // Defence-in-depth from T005's payload validator.
    expect(ctx.peer.payloadViolations.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // FR-007 — zero `Invalid relay message, skipping` on a full open→ack cycle
  // -------------------------------------------------------------------------
  it('FR-007: no Invalid-relay-message warnings on a full open→ack cycle', async () => {
    const args = commonOpenInput();
    const runId = 'rid-fr7';

    const open = unwrap(await ctx.mcp!.gateOpen({ ...args, runId }));
    await waitFor(
      () => ctx.fakeCloud!.getByKey(args.issueRef, args.gateType, args.generation, runId) != null,
      3000,
      'expected gate-open frame to reach fake cloud',
    );
    unwrap(
      await ctx.mcp!.gateAck({
        gateId: open.gateId,
        outcome: 'applied',
      }),
    );

    // Zero light-orchestrator warns/errors carrying the sentinel string.
    const bad = ctx.loggerRecords.filter((r) => r.msg.includes('Invalid relay message, skipping'));
    expect(bad.length).toBe(0);

    // And zero payload violations at the fake peer (belt-and-braces).
    expect(ctx.peer.payloadViolations.length).toBe(0);
  });
});
