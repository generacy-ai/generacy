/**
 * Cockpit gates — cluster-side integration harness (#1024).
 *
 * This file has two tiers of tests:
 *
 *   1. **Harness plumbing self-tests** (the `describe('Harness plumbing…')`
 *      block below) — real running tests that boot `setupScenario`, exercise
 *      the fake-peer WebSocket lifecycle (handshake, api_request/response
 *      correlation, disconnect+reconnect), verify the orchestrator boot
 *      landed on a real random port, and spawn+kill+restart the doorbell
 *      driver against an injected synthetic child script. These provide
 *      regression signal against the harness scaffolding itself right now —
 *      no sibling infrastructure required.
 *
 *   2. **Sibling-dependent scenarios** (S1a, S1b, S2, S3, S4, S5, F1, F2,
 *      F3 — the eight scenarios named in
 *      `specs/1024-part-cockpit-remote-gates/contracts/scenario-catalog.md`).
 *      Currently `it.skip(...)` with a `TODO(#<sibling>):` comment on each,
 *      because their asserted infrastructure (POST /cockpit/gates route,
 *      POST /cockpit/answers route, `cluster.cockpit` in
 *      `ALLOWED_CHANNELS`, retain-and-replay, the answers-file writer, the
 *      doorbell answers-file tail, and the shared fixture builders) lives
 *      in sibling PRs #1025 (issue #1020), #1027 (issue #1021), #1028
 *      (issue #1023), and #1029 (issue #1022) — none of which have landed
 *      on `develop` as of 2026-07-21.
 *
 * SC-004 (wire-shape single-sourcing): every scenario that unskips MUST
 * import its contract shapes from the gates module exported by sibling
 * #1020 — never inline a Zod schema literal, never inline a
 * discriminator-keyed object literal for a wire body. Construct every
 * wire body via the fixture builders exported by the module
 * (gate-open, answer-line, outcome-ack). See
 * `specs/1024-part-cockpit-remote-gates/contracts/fake-peer-protocol.md`.
 * Reviewer: reject this PR if the SC-004 grep (see `contracts/scenario-catalog.md`
 * §"SC-004 verification") returns non-zero matches against this file when
 * scenarios are unskipped.
 *
 * See `specs/1024-part-cockpit-remote-gates/tasks.md` §"T001 audit
 * result" for the full seam matrix.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { once } from 'node:events';
import { WebSocket as WsWebSocket } from 'ws';
import {
  setupScenario,
  type ScenarioContext,
} from './cockpit-gates/scenario-helpers.js';

// A synthetic doorbell child that stands in for sibling #1023's unlanded
// answers-file tail. Emits one `{ type: 'ready', ... }` JSON line on
// startup so `DoorbellDriver.start()`'s smoke-test succeeds, then waits
// for SIGTERM. Sufficient to exercise the spawn/stop/restart mechanics of
// `DoorbellDriver` — the real answers-file tailing lives in #1023.
const SYNTHETIC_DOORBELL_SCRIPT = [
  "process.stdout.write(JSON.stringify({ type: 'ready', pid: process.pid }) + '\\n');",
  "process.on('SIGTERM', () => { process.exit(0); });",
  // Keep the process alive.
  "setInterval(() => {}, 60000);",
].join(' ');

/**
 * Minimum valid `HandshakeMessage` per `RelayMessageSchema` in
 * `@generacy-ai/cluster-relay`. Fake peer's `safeParse` drops frames that
 * don't match the schema, so raw-WS test clients that want to be
 * observable in `peer.received.handshakes` must send this exact shape.
 */
function validHandshakeFrame(): Record<string, unknown> {
  return {
    type: 'handshake',
    metadata: {
      workers: 1,
      activeWorkflows: 0,
      channel: 'preview',
      orchestratorVersion: '0.0.0-test',
      gitRemotes: [],
      uptime: 0,
      clusterId: 'test-cluster',
    },
  };
}

describe('Cockpit gates integration', () => {
  describe('Harness plumbing', () => {
    let ctx: ScenarioContext;

    beforeEach(async () => {
      ctx = await setupScenario();
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    it('boots the orchestrator on a real random port and serves HTTP', async () => {
      // `createTestServer` uses `skipRoutes: true`, so no routes are
      // registered — but Fastify still returns a well-formed 404 JSON
      // response for any request. That's sufficient to prove the boot +
      // `.listen({ port: 0 })` wire-up in `setupScenario` produced a live
      // server. Sibling scenarios that need `/cockpit/gates` etc. register
      // their routes on this instance before asserting.
      expect(ctx.orchestratorUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${ctx.orchestratorUrl}/__does_not_exist__`);
      // 404 for an unregistered route still proves Fastify is listening on
      // the random port and answering HTTP requests.
      expect(res.status).toBe(404);
    });

    it('fake peer accepts a raw WebSocket connection and handshake', async () => {
      // Directly exercise the fake peer's ws handling — no orchestrator
      // relay client needed. Proves the WebSocketServer and the
      // handshake-triggered heartbeat wire-up work.
      const client = new WsWebSocket(ctx.peer.url);
      await once(client, 'open');

      client.send(JSON.stringify(validHandshakeFrame()));

      // The peer replies with a heartbeat frame in response to a valid
      // handshake — wait for it to arrive.
      const [raw] = (await once(client, 'message')) as [Buffer];
      const reply = JSON.parse(raw.toString()) as { type: string };
      expect(reply.type).toBe('heartbeat');
      expect(ctx.peer.received.handshakes).toHaveLength(1);
      expect(ctx.peer.received.handshakes[0]).toMatchObject({
        type: 'handshake',
        metadata: { clusterId: 'test-cluster' },
      });

      client.close();
      await once(client, 'close');
    });

    it('fake peer round-trips an api_request via correlationId', async () => {
      // Connect a raw client, register an api_response listener that
      // echoes back the correlationId whenever an api_request arrives.
      // Then have the fake peer send an api_request and assert
      // sendApiRequest resolves with the matching response.
      const client = new WsWebSocket(ctx.peer.url);
      await once(client, 'open');
      client.send(JSON.stringify(validHandshakeFrame()));
      // Drain the handshake heartbeat reply so subsequent listeners are
      // triggered by real frames.
      await once(client, 'message');

      client.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          correlationId?: string;
        };
        if (msg.type === 'api_request' && msg.correlationId != null) {
          client.send(
            JSON.stringify({
              type: 'api_response',
              correlationId: msg.correlationId,
              status: 200,
              body: { echoed: true },
            }),
          );
        }
      });

      const response = await ctx.peer.sendApiRequest(
        'POST',
        '/echo',
        { hello: 'world' },
        3000,
      );
      expect(response.type).toBe('api_response');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ echoed: true });

      client.close();
      await once(client, 'close');
    });

    it('fake peer supports disconnectAllClients + waitForReconnect', async () => {
      // Regression signal for FR-004's disconnect+reconnect helper pair.
      const first = new WsWebSocket(ctx.peer.url);
      await once(first, 'open');
      first.send(JSON.stringify(validHandshakeFrame()));
      await once(first, 'message');

      // Drop all clients, then start a fresh one and wait for the peer to
      // register the new connection. Skipping `await once(first, 'close')`
      // because — depending on the ws version — a server-side terminate()
      // doesn't always drive a synchronous 'close' event on the client
      // side. What we actually care about here is that a NEW connection
      // successfully reaches the peer after a disconnect, which is what
      // `waitForReconnect` asserts.
      await ctx.peer.disconnectAllClients();

      const reconnectPromise = ctx.peer.waitForReconnect(3000);
      const second = new WsWebSocket(ctx.peer.url);
      await once(second, 'open');
      await reconnectPromise;

      first.terminate();
      second.close();
    });

    it('doorbell driver spawns a synthetic child, captures its stdout, and stops cleanly', async () => {
      // Exercise the spawn/parse/stop plumbing WITHOUT depending on the
      // unlanded #1023 answers-file tail — the driver's `generacyBin`
      // override lets us inject a synthetic child that emits a single
      // JSON line and waits for SIGTERM. This confirms the spawn +
      // stdout-line-buffered parse + SIGTERM stop path all work today.
      const doorbellCtx = await setupScenario({
        skipDoorbell: false,
        doorbellDriverOptions: {
          nodeBin: process.execPath,
          spawnArgv: ['-e', SYNTHETIC_DOORBELL_SCRIPT],
        },
      });
      try {
        // The `start()` inside `setupScenario` already blocked on the
        // first stdout line; the child announced itself as ready.
        expect(doorbellCtx.doorbell.events.length).toBeGreaterThanOrEqual(1);
        const ready = doorbellCtx.doorbell.events.find(
          (e) => e.type === 'ready',
        );
        expect(ready).toBeDefined();
        expect((ready as { pid: number }).pid).toBeTypeOf('number');
      } finally {
        await doorbellCtx.cleanup();
      }
    });

    it('doorbell driver restart re-runs the child and preserves the events history', async () => {
      // Regression signal for FR-007's restart-replay assertion path —
      // the driver's `restart()` must SIGTERM the current child, wait for
      // exit, spawn a fresh one, and NOT reset the `events` array (so the
      // caller can distinguish pre-restart from post-restart by offset).
      const doorbellCtx = await setupScenario({
        skipDoorbell: false,
        doorbellDriverOptions: {
          nodeBin: process.execPath,
          spawnArgv: ['-e', SYNTHETIC_DOORBELL_SCRIPT],
        },
      });
      try {
        const beforeRestart = doorbellCtx.doorbell.events.length;
        expect(beforeRestart).toBeGreaterThanOrEqual(1);
        const preRestartReady = doorbellCtx.doorbell.events.find(
          (e) => e.type === 'ready',
        ) as { pid: number };

        await doorbellCtx.doorbell.restart();

        // After restart the synthetic child re-emits its ready line, so
        // events.length has grown and a second 'ready' event with a
        // different PID exists.
        expect(doorbellCtx.doorbell.events.length).toBeGreaterThan(
          beforeRestart,
        );
        const postRestartReadies = doorbellCtx.doorbell.events.filter(
          (e) => e.type === 'ready',
        );
        expect(postRestartReadies.length).toBeGreaterThanOrEqual(2);
        const postRestartReady = postRestartReadies[
          postRestartReadies.length - 1
        ] as { pid: number };
        expect(postRestartReady.pid).not.toBe(preRestartReady.pid);
      } finally {
        await doorbellCtx.cleanup();
      }
    });

    it('awaitCockpitEvents returns an empty batch stub until #1023 wires the bus', async () => {
      // Regression signal that the helper is callable during scenario
      // wire-up (was `throw` in a prior revision — broke setup for
      // scenarios that reach into the MCP bus). When #1023 lands a real
      // in-process bus accessor, this test flips to assert real entries.
      const { awaitCockpitEvents } = await import(
        './cockpit-gates/scenario-helpers.js'
      );
      const batch = await awaitCockpitEvents(0);
      expect(batch.entries).toEqual([]);
      expect(batch.cursor).toBe(0);
    });
  });

  describe('Sibling-dependent scenarios', () => {
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
      void ctx;
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
      void ctx;
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
      void ctx;
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
      void ctx;
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
      void ctx;
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
      void ctx;
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
      void ctx;
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
      void ctx;
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
      void ctx;
    });
  });
});
