/**
 * Cockpit gates — cluster-side integration harness (#1024).
 *
 * SC-004 (wire-shape single-sourcing): every scenario in this file MUST
 * import its contract shapes from the gates module exported by sibling
 * #1020 — never inline a Zod schema literal, never inline a
 * discriminator-keyed object literal for a wire body. Construct every
 * wire body via the fixture builders exported by the module
 * (gate-open, answer-line, outcome-ack). See
 * `specs/1024-part-cockpit-remote-gates/contracts/fake-peer-protocol.md`.
 * Reviewer: reject this PR if the SC-004 grep (see `contracts/scenario-catalog.md`
 * §"SC-004 verification") returns non-zero matches against this file.
 *
 * Current status (2026-07-21): none of the four P1 siblings (#1020
 * contracts, #1021 orchestrator routes + cluster.cockpit + answers-file
 * writer, #1022 MCP cockpit_gate_open/ack, #1023 doorbell answers-file
 * tail) have landed on `develop`. Every scenario below is authored as
 * `it.skip(...)` with a `// TODO(#<sibling>):` comment naming the
 * sibling(s) that must land before it can unskip. The `.skip()`s
 * document intent and pin the file layout; they do not silently pass —
 * Vitest reports each as `skipped` in the run output.
 *
 * See `specs/1024-part-cockpit-remote-gates/tasks.md` §"T001 audit
 * result" for the full seam matrix.
 */
import { describe, it, beforeEach, afterEach } from 'vitest';
import {
  setupScenario,
  type ScenarioContext,
} from './cockpit-gates/scenario-helpers.js';

describe('Cockpit gates integration', () => {
  let ctx: ScenarioContext;

  beforeEach(async () => {
    ctx = await setupScenario();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  // ---------------------------------------------------------------------------
  // Scenario S1a — Gate open → cluster.cockpit event (FR-003).
  //
  // TODO(#1020, #1021): unskip once the gates module exports
  // `gateOpenFixture` (S-10) via `@generacy-ai/cockpit/gates` (S-9) and the
  // orchestrator adds `POST /cockpit/gates` + `'cluster.cockpit'` to
  // ALLOWED_CHANNELS (S-2, S-4).
  // ---------------------------------------------------------------------------
  it.skip('S1a — gate open POST produces a cluster.cockpit event byte-equal to the contract', async () => {
    // Sketch (fill in after siblings land):
    //   const body = gateOpenFixture({ gateType: 'phase-queue' });
    //   const resp = await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, {
    //     method: 'POST',
    //     headers: { 'content-type': 'application/json' },
    //     body: JSON.stringify(body),
    //   });
    //   expect(resp.status).toBe(200);
    //   const event = await ctx.peer.waitForEvent(
    //     'cluster.cockpit',
    //     (d) => (d as { kind: string }).kind === 'gate-open',
    //   );
    //   expect((event.data as { gate: unknown }).gate).toEqual(body);
  });

  // ---------------------------------------------------------------------------
  // Scenario S1b — Retain-and-replay across disconnect (FR-004).
  //
  // TODO(#1021): unskip once the retain-and-replay branch for
  // `cluster.cockpit` is wired into `routes/internal-relay-events.ts` (S-3).
  // If #1021 implements retention in a separate `retained-cockpit-event.ts`
  // module mirroring `retained-tunnel-event.ts`, the hookup ≤20 LOC — see
  // plan D-2.
  // ---------------------------------------------------------------------------
  it.skip('S1b — retain-and-replay: disconnect + gate-open + reconnect → event on new socket', async () => {
    // Sketch:
    //   await ctx.peer.disconnectAllClients();
    //   const body = gateOpenFixture();
    //   await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, { method: 'POST', body: JSON.stringify(body) });
    //   await ctx.peer.waitForReconnect();
    //   const event = await ctx.peer.waitForEvent('cluster.cockpit', (d) => (d as { kind: string }).kind === 'gate-open');
    //   expect(event.data).toMatchObject({ gate: body });
    //   expect(ctx.peer.received.events.filter((e) => e.event === 'cluster.cockpit')).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Scenario S2 — Answer down-path: peer api_request → file + doorbell +
  // MCP bus (FR-005).
  //
  // TODO(#1021, #1023): unskip once the answers-file writer exists (S-1),
  // the doorbell tails the answers file (S-5), and `awaitCockpitEvents` is
  // reachable from the harness (S-7-adjacent).
  // ---------------------------------------------------------------------------
  it.skip('S2 — peer api_request POST /cockpit/answers surfaces file line + doorbell event + bus entry', async () => {
    // Sketch:
    //   const gate = gateOpenFixture();
    //   await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, { method: 'POST', body: JSON.stringify(gate) });
    //   const answer = answerLineFixture({ deliveryId: 'delivery-1', gateId: gate.gateId });
    //   const resp = await ctx.peer.sendApiRequest('POST', '/cockpit/answers', answer);
    //   expect(resp.status).toBe(200);
    //   const contents = (await readFile(ctx.answersFilePath, 'utf8')).trim().split('\n').filter(Boolean);
    //   expect(contents).toHaveLength(1);
    //   const emitted = await ctx.doorbell.waitForEvent((e) => e.type === 'gate-answer' && e.deliveryId === 'delivery-1');
    //   expect(emitted).toMatchObject({ type: 'gate-answer', gateId: gate.gateId });
    //   const batch = await awaitCockpitEvents(0);
    //   expect(batch.entries.some((e) => e.event.type === 'gate-answer')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Scenario S3 — Ack → outcome relay event (FR-006).
  //
  // TODO(#1021): unskip once `POST /cockpit/gates/:id/ack` (S-4) exists.
  // ---------------------------------------------------------------------------
  it.skip('S3 — ack POST produces a cluster.cockpit outcome event byte-equal to the contract', async () => {
    // Sketch:
    //   const gate = gateOpenFixture();
    //   await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, { method: 'POST', body: JSON.stringify(gate) });
    //   const outcome = outcomeAckFixture({ gateId: gate.gateId, outcome: 'applied' });
    //   const resp = await fetch(`${ctx.orchestratorUrl}/cockpit/gates/${gate.gateId}/ack`, {
    //     method: 'POST',
    //     headers: { 'content-type': 'application/json' },
    //     body: JSON.stringify(outcome),
    //   });
    //   expect(resp.status).toBe(200);
    //   const event = await ctx.peer.waitForEvent('cluster.cockpit', (d) => (d as { kind: string }).kind === 'outcome');
    //   expect((event.data as { outcome: unknown }).outcome).toEqual(outcome);
  });

  // ---------------------------------------------------------------------------
  // Scenario S4 — Restart replay of unacked answers exactly once (FR-007).
  //
  // TODO(#1021, #1023): unskip once the doorbell tails the answers file and
  // its startup path re-reads from head per clarification Q1 → B (S-7).
  // ---------------------------------------------------------------------------
  it.skip('S4 — doorbell kill+restart mid-flow re-emits each unacked answer exactly once', async () => {
    // Sketch:
    //   const gate = gateOpenFixture();
    //   await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, { method: 'POST', body: JSON.stringify(gate) });
    //   const answer = answerLineFixture({ deliveryId: 'delivery-restart', gateId: gate.gateId });
    //   await ctx.peer.sendApiRequest('POST', '/cockpit/answers', answer);
    //   await ctx.doorbell.waitForEvent((e) => e.deliveryId === 'delivery-restart');
    //   await ctx.doorbell.restart();
    //   // Poll for restart re-emit; assert TOTAL emits across full lifetime === 2 (one pre, one post).
    //   await waitFor(() => ctx.doorbell.events.filter((e) => e.deliveryId === 'delivery-restart').length === 2, 5000);
  });

  // ---------------------------------------------------------------------------
  // Scenario S5 — deliveryId dedup end-to-end (FR-008).
  //
  // Both layers asserted: (a) writer file-level dedup, (b) doorbell/bus
  // in-process dedup. Distinct expects so a single-layer regression is
  // attributable to the responsible sibling.
  //
  // TODO(#1021, #1023): unskip once (a) the writer dedups by deliveryId
  // pre-append and (b) the doorbell dedups in-process.
  // ---------------------------------------------------------------------------
  it.skip('S5 — same deliveryId twice → one file line, one doorbell event, one bus entry', async () => {
    // Sketch:
    //   const gate = gateOpenFixture();
    //   await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, { method: 'POST', body: JSON.stringify(gate) });
    //   const first = answerLineFixture({ deliveryId: 'delivery-dup', gateId: gate.gateId });
    //   const second = answerLineFixture({ deliveryId: 'delivery-dup', gateId: gate.gateId });
    //   await ctx.peer.sendApiRequest('POST', '/cockpit/answers', first);
    //   await ctx.peer.sendApiRequest('POST', '/cockpit/answers', second);
    //   const lines = (await readFile(ctx.answersFilePath, 'utf8')).trim().split('\n').filter(Boolean);
    //   const dedupedLines = lines.filter((l) => l.includes('delivery-dup'));
    //   expect(dedupedLines).toHaveLength(1); // layer (a)
    //   const dedupedEvents = ctx.doorbell.events.filter((e) => e.deliveryId === 'delivery-dup');
    //   expect(dedupedEvents).toHaveLength(1); // layer (b)
    //   const batch = await awaitCockpitEvents(0);
    //   const busEntries = batch.entries.filter((e) => (e.event as { deliveryId?: string }).deliveryId === 'delivery-dup');
    //   expect(busEntries).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Scenario F1 — malformed answer NDJSON line skipped-and-logged (FR-013).
  //
  // TODO(#1023): unskip once the doorbell has a tail path that must be
  // tolerant of garbage lines.
  // ---------------------------------------------------------------------------
  it.skip('F1 — malformed answers-file line is skipped and logged; subsequent well-formed lines still surface', async () => {
    // Sketch:
    //   await appendFile(ctx.answersFilePath, 'this is not json\n');
    //   const gate = gateOpenFixture();
    //   await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, { method: 'POST', body: JSON.stringify(gate) });
    //   const answer = answerLineFixture({ deliveryId: 'delivery-after-garbage', gateId: gate.gateId });
    //   await ctx.peer.sendApiRequest('POST', '/cockpit/answers', answer);
    //   await ctx.doorbell.waitForEvent((e) => e.type === 'gate-answer' && e.deliveryId === 'delivery-after-garbage');
    //   expect(ctx.doorbell.stdoutLines.some((l) => /malformed|parse/i.test(l))).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Scenario F2 — invalid gate-open body → 4xx + no relay event (FR-014).
  //
  // TODO(#1021): unskip once `POST /cockpit/gates` exists and validates.
  // ---------------------------------------------------------------------------
  it.skip('F2 — invalid gate-open body → 4xx and no cluster.cockpit event leaks to the peer', async () => {
    // Sketch:
    //   const resp = await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, {
    //     method: 'POST',
    //     headers: { 'content-type': 'application/json' },
    //     body: JSON.stringify({}),
    //   });
    //   expect(resp.status).toBeGreaterThanOrEqual(400);
    //   expect(resp.status).toBeLessThan(500);
    //   await new Promise((r) => setTimeout(r, 200));
    //   expect(ctx.peer.received.events.filter((e) => e.event === 'cluster.cockpit')).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Scenario F3 — answers-file rotation preserves unacked lines (FR-015).
  //
  // TODO(#1023): unskip once the doorbell tail path tolerates file rotation.
  // ---------------------------------------------------------------------------
  it.skip('F3 — rename+recreate the answers file mid-flow; subsequent injections still surface', async () => {
    // Sketch:
    //   const gate = gateOpenFixture();
    //   await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, { method: 'POST', body: JSON.stringify(gate) });
    //   const first = answerLineFixture({ deliveryId: 'delivery-pre-rotation', gateId: gate.gateId });
    //   await ctx.peer.sendApiRequest('POST', '/cockpit/answers', first);
    //   await ctx.doorbell.waitForEvent((e) => e.deliveryId === 'delivery-pre-rotation');
    //   await rename(ctx.answersFilePath, `${ctx.answersFilePath}.1`);
    //   await writeFile(ctx.answersFilePath, '', 'utf8');
    //   const second = answerLineFixture({ deliveryId: 'delivery-post-rotation', gateId: gate.gateId });
    //   await ctx.peer.sendApiRequest('POST', '/cockpit/answers', second);
    //   await ctx.doorbell.waitForEvent((e) => e.deliveryId === 'delivery-post-rotation');
  });
});
