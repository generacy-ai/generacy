/**
 * Cockpit gates — cluster-side integration harness (#1024).
 *
 * Proves the whole cluster-side path of the Cockpit Remote Gates epic
 * end-to-end against a fake relay peer — no cloud, no live GitHub, no smee
 * (FR-002, FR-010). Composes the four P1 siblings:
 *   - #1020 wire contracts + fixture builders (`@generacy-ai/cockpit`)
 *   - #1021 orchestrator gate/answer routes, `cluster.cockpit` relay emit +
 *     retain-and-replay, answers-file writer
 *   - #1022 MCP gate tools (exercised via the same HTTP routes; see env-seams
 *     S-8 — not asserted through the MCP protocol here)
 *   - #1023 doorbell answers-file tail (spawned as a REAL child process)
 *
 * Two tiers of tests:
 *   1. **Harness plumbing self-tests** — regression signal for the fake-peer +
 *      doorbell-driver + light-orchestrator scaffolding itself.
 *   2. **Cross-component scenarios** — the eight scenarios of
 *      `contracts/scenario-catalog.md` (S1a, S1b, S2, S3, S4, S5, F1, F2, F3),
 *      each with real assertions.
 *
 * SC-004 (wire-shape single-sourcing): every wire body is built through the
 * fixture builders exported by `@generacy-ai/cockpit` (`gateOpenFixture`,
 * `gateAckFixture`, `answerLineFixture`) — never an inline schema literal.
 * Invalid-body scenarios (F2) derive from a fixture, then drop a field.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { once } from 'node:events';
import { readFile, appendFile, rename, writeFile } from 'node:fs/promises';
import { WebSocket as WsWebSocket } from 'ws';
import {
  gateOpenFixture,
  gateAckFixture,
  answerLineFixture,
} from '@generacy-ai/cockpit';
import {
  setupScenario,
  waitFor,
  type ScenarioContext,
} from './cockpit-gates/scenario-helpers.js';

const JSON_HEADERS = { 'content-type': 'application/json' };

// A synthetic doorbell child that stands in for the real answers-file tail in
// the driver plumbing self-tests. Emits one `{ type: 'ready', ... }` JSON line
// on startup so `DoorbellDriver.start()`'s smoke-test succeeds, then waits for
// SIGTERM. Exercises the spawn/stop/restart mechanics without the built dist.
const SYNTHETIC_DOORBELL_SCRIPT = [
  "process.stdout.write(JSON.stringify({ type: 'ready', pid: process.pid }) + '\\n');",
  "process.on('SIGTERM', () => { process.exit(0); });",
  'setInterval(() => {}, 60000);',
].join(' ');

/**
 * Minimum valid `HandshakeMessage` per `RelayMessageSchema` in
 * `@generacy-ai/cluster-relay`. Fake peer's `safeParse` drops frames that don't
 * match, so raw-WS test clients that want to be observable in
 * `peer.received.handshakes` must send this exact shape.
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

function cockpitEvents(ctx: ScenarioContext, gateId: string) {
  return ctx.peer.received.events.filter(
    (e) =>
      e.event === 'cluster.cockpit' &&
      (e.data as { gateId?: string }).gateId === gateId,
  );
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

    it('boots the light orchestrator on a real random port and serves the gate routes', async () => {
      expect(ctx.orchestratorUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      // Unknown route → 404 proves Fastify is listening and answering HTTP.
      const res = await fetch(`${ctx.orchestratorUrl}/__does_not_exist__`);
      expect(res.status).toBe(404);
    });

    it('connects the real relay client to the fake peer (handshake observed)', async () => {
      expect(ctx.relayClient.isConnected).toBe(true);
      expect(ctx.peer.received.handshakes.length).toBeGreaterThanOrEqual(1);
    });

    it('fake peer accepts a raw WebSocket connection and handshake', async () => {
      const client = new WsWebSocket(ctx.peer.url);
      await once(client, 'open');
      client.send(JSON.stringify(validHandshakeFrame()));
      const [raw] = (await once(client, 'message')) as [Buffer];
      const reply = JSON.parse(raw.toString()) as { type: string };
      expect(reply.type).toBe('heartbeat');
      client.close();
      await once(client, 'close');
    });

    it('doorbell driver spawns a synthetic child, captures its stdout, and stops cleanly', async () => {
      const doorbellCtx = await setupScenario({
        doorbellDriverOptions: {
          nodeBin: process.execPath,
          spawnArgv: ['-e', SYNTHETIC_DOORBELL_SCRIPT],
        },
      });
      try {
        expect(doorbellCtx.doorbell).not.toBeNull();
        expect(doorbellCtx.doorbell!.events.length).toBeGreaterThanOrEqual(1);
        const ready = doorbellCtx.doorbell!.events.find((e) => e.type === 'ready');
        expect(ready).toBeDefined();
        expect((ready as { pid: number }).pid).toBeTypeOf('number');
      } finally {
        await doorbellCtx.cleanup();
      }
    });

    it('doorbell driver restart re-runs the child and preserves the events history', async () => {
      const doorbellCtx = await setupScenario({
        doorbellDriverOptions: {
          nodeBin: process.execPath,
          spawnArgv: ['-e', SYNTHETIC_DOORBELL_SCRIPT],
        },
      });
      try {
        const beforeRestart = doorbellCtx.doorbell!.events.length;
        expect(beforeRestart).toBeGreaterThanOrEqual(1);
        const preReady = doorbellCtx.doorbell!.events.find(
          (e) => e.type === 'ready',
        ) as { pid: number };

        await doorbellCtx.doorbell!.restart();

        expect(doorbellCtx.doorbell!.events.length).toBeGreaterThan(beforeRestart);
        const readies = doorbellCtx.doorbell!.events.filter(
          (e) => e.type === 'ready',
        );
        expect(readies.length).toBeGreaterThanOrEqual(2);
        const postReady = readies[readies.length - 1] as { pid: number };
        expect(postReady.pid).not.toBe(preReady.pid);
      } finally {
        await doorbellCtx.cleanup();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Relay-path scenarios (no doorbell). A moderate reconnect delay gives S1b a
  // reliable window to POST while the client is disconnected.
  // ---------------------------------------------------------------------------
  describe('Relay path', () => {
    let ctx: ScenarioContext;

    beforeEach(async () => {
      ctx = await setupScenario({ relayReconnectMs: 1000 });
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    // S1a — Gate open → cluster.cockpit event (FR-003).
    it('S1a — gate-open POST emits a cluster.cockpit event equal to the wire body', async () => {
      const body = gateOpenFixture({ gateId: 'g_s1a' });
      const res = await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(202);
      expect((await res.json()).retained).toBe(false);

      const event = await ctx.peer.waitForEvent(
        'cluster.cockpit',
        (d) => (d as { gateId?: string }).gateId === 'g_s1a',
      );
      expect(event.data).toMatchObject(body);
    });

    // S1b — Retain-and-replay across disconnect (FR-004).
    it('S1b — gate-open during a disconnect is retained and replayed once on reconnect', async () => {
      await ctx.peer.disconnectAllClients();
      await waitFor(
        () => !ctx.relayClient.isConnected,
        3000,
        'relay client never observed the disconnect',
      );

      const body = gateOpenFixture({ gateId: 'g_s1b' });
      const res = await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(202);
      // Client is disconnected → the route must retain, not emit.
      expect((await res.json()).retained).toBe(true);

      // On reconnect the retainer drains; the event lands on the new socket.
      const event = await ctx.peer.waitForEvent(
        'cluster.cockpit',
        (d) => (d as { gateId?: string }).gateId === 'g_s1b',
        8000,
      );
      expect(event.data).toMatchObject(body);

      // Exactly once — no duplicate from a double-drain.
      await new Promise((r) => setTimeout(r, 300));
      expect(cockpitEvents(ctx, 'g_s1b')).toHaveLength(1);
    });

    // S3 — Ack → outcome relay event (FR-006).
    it('S3 — ack POST emits a cluster.cockpit gate-ack event carrying the path gateId', async () => {
      const gateId = 'g_s3';
      const ack = gateAckFixture({ gateId, outcome: 'answered' });
      const res = await fetch(
        `${ctx.orchestratorUrl}/cockpit/gates/${gateId}/ack`,
        { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(ack) },
      );
      expect(res.status).toBe(202);

      const event = await ctx.peer.waitForEvent(
        'cluster.cockpit',
        (d) =>
          (d as { kind?: string }).kind === 'gate-ack' &&
          (d as { gateId?: string }).gateId === gateId,
      );
      expect((event.data as { gateId: string }).gateId).toBe(gateId);
      expect((event.data as { outcome: string }).outcome).toBe('answered');
    });

    // F2 — Invalid gate-open body → 4xx + no relay event (FR-014).
    it('F2 — invalid gate-open body → 400 and no cluster.cockpit event leaks to the peer', async () => {
      // Derive from the fixture (SC-004), then drop a required field.
      const invalid = gateOpenFixture({ gateId: 'g_f2' }) as Record<string, unknown>;
      delete invalid['openedAt'];

      const res = await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(invalid),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('VALIDATION');

      // Grace window, then assert no event leaked.
      await new Promise((r) => setTimeout(r, 300));
      expect(
        ctx.peer.received.events.filter((e) => e.event === 'cluster.cockpit'),
      ).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Answer down-path scenarios — spawn the REAL doorbell child (hermetic mode)
  // so the answers-file tail + stdout emit are exercised across a process
  // boundary (clarification Q3 → C).
  //
  // NB on the "MCP bus" (assertion primitive #5): the doorbell emits each
  // gate-answer to BOTH stdout AND its in-process EpicEventBus from the same
  // object. That bus lives in `@generacy-ai/generacy`, which depends on this
  // package (`workspace:*`) — importing it here would close a build cycle — so
  // the harness asserts the byte-identical stdout surface (`ctx.doorbell.events`)
  // that `cockpit_await_events` would drain.
  // ---------------------------------------------------------------------------
  describe('Answer down-path (real doorbell)', () => {
    let ctx: ScenarioContext;

    beforeEach(async () => {
      ctx = await setupScenario({ startDoorbell: true });
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    async function fileLines(ctxLocal: ScenarioContext): Promise<string[]> {
      const raw = await readFile(ctxLocal.answersFilePath, 'utf8');
      return raw.trim().split('\n').filter(Boolean);
    }

    // S2 — Answer down-path: peer api_request → file + doorbell (FR-005).
    it('S2 — peer POST /cockpit/answers writes one file line and surfaces a doorbell gate-answer', async () => {
      const answer = answerLineFixture({ deliveryId: 'dlv_s2', gateId: 'g_s2' });
      const res = await ctx.peer.sendApiRequest('POST', '/cockpit/answers', answer);
      expect(res.status).toBe(200);

      await waitFor(
        async () =>
          (await fileLines(ctx)).some((l) => l.includes('dlv_s2')),
        5000,
        'answer line never appeared in the answers file',
      );
      const lines = await fileLines(ctx);
      expect(lines.filter((l) => l.includes('dlv_s2'))).toHaveLength(1);

      const emitted = await ctx.doorbell!.waitForEvent(
        (e) => e.type === 'gate-answer' && e['deliveryId'] === 'dlv_s2',
      );
      expect(emitted).toMatchObject({ type: 'gate-answer', gateId: 'g_s2' });
    });

    // S4 — Restart replay of unacked answers exactly once (FR-007).
    it('S4 — doorbell kill+restart mid-flow re-emits the unacked answer exactly once', async () => {
      const answer = answerLineFixture({ deliveryId: 'dlv_s4', gateId: 'g_s4' });
      await ctx.peer.sendApiRequest('POST', '/cockpit/answers', answer);
      await ctx.doorbell!.waitForEvent(
        (e) => e.type === 'gate-answer' && e['deliveryId'] === 'dlv_s4',
      );
      const emitsFor = () =>
        ctx.doorbell!.events.filter(
          (e) => e.type === 'gate-answer' && e['deliveryId'] === 'dlv_s4',
        ).length;
      expect(emitsFor()).toBe(1);

      // Restart: the doorbell re-reads the answers file from head (position
      // model Q1 → B) and re-emits the still-unacked line — exactly once.
      await ctx.doorbell!.restart(1500);
      await waitFor(() => emitsFor() === 2, 6000, 'restart did not re-emit the unacked answer');

      // And it does NOT re-emit a third time.
      await new Promise((r) => setTimeout(r, 400));
      expect(emitsFor()).toBe(2);
    });

    // S5 — deliveryId dedup end-to-end (FR-008).
    it('S5 — the same deliveryId twice yields one file line and one doorbell event', async () => {
      const first = answerLineFixture({ deliveryId: 'dlv_dup', gateId: 'g_s5' });
      const second = answerLineFixture({ deliveryId: 'dlv_dup', gateId: 'g_s5' });
      const r1 = await ctx.peer.sendApiRequest('POST', '/cockpit/answers', first);
      const r2 = await ctx.peer.sendApiRequest('POST', '/cockpit/answers', second);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      // Layer (a): the writer dedups by deliveryId — exactly one file line.
      await waitFor(
        async () => (await fileLines(ctx)).some((l) => l.includes('dlv_dup')),
        5000,
        'answer line never appeared in the answers file',
      );
      const lines = await fileLines(ctx);
      expect(lines.filter((l) => l.includes('dlv_dup'))).toHaveLength(1);

      // Layer (b): a clean file means the doorbell surfaces it exactly once.
      await ctx.doorbell!.waitForEvent(
        (e) => e.type === 'gate-answer' && e['deliveryId'] === 'dlv_dup',
      );
      await new Promise((r) => setTimeout(r, 400));
      expect(
        ctx.doorbell!.events.filter(
          (e) => e.type === 'gate-answer' && e['deliveryId'] === 'dlv_dup',
        ),
      ).toHaveLength(1);
    });

    // F1 — Malformed answer NDJSON line skipped-and-logged (FR-013).
    it('F1 — a malformed answers-file line is skipped and logged; later valid lines still surface', async () => {
      // Inject garbage directly (bypassing the writer's validation), then a
      // valid line via the route.
      await appendFile(ctx.answersFilePath, 'this is not valid json\n');
      const answer = answerLineFixture({
        deliveryId: 'dlv_after_garbage',
        gateId: 'g_f1',
      });
      await ctx.peer.sendApiRequest('POST', '/cockpit/answers', answer);

      // The doorbell did not crash on the garbage line: it still emits the
      // subsequent valid one.
      const emitted = await ctx.doorbell!.waitForEvent(
        (e) => e.type === 'gate-answer' && e['deliveryId'] === 'dlv_after_garbage',
        6000,
      );
      expect(emitted).toMatchObject({ type: 'gate-answer' });

      // The garbage line was logged (doorbell logs malformed lines to stderr).
      expect(ctx.doorbell!.stderrText()).toMatch(/malformed/i);
      // …and never surfaced as an event.
      expect(
        ctx.doorbell!.events.some(
          (e) => JSON.stringify(e).includes('not valid json'),
        ),
      ).toBe(false);
    });

    // F3 — Answers-file rotation preserves the tail (FR-015).
    it('F3 — rename+recreate the answers file mid-flow; subsequent lines still surface', async () => {
      const first = answerLineFixture({ deliveryId: 'dlv_pre_rot', gateId: 'g_f3' });
      await ctx.peer.sendApiRequest('POST', '/cockpit/answers', first);
      await ctx.doorbell!.waitForEvent(
        (e) => e.type === 'gate-answer' && e['deliveryId'] === 'dlv_pre_rot',
      );

      // Rotate: rename the current file away and recreate it fresh (new inode).
      await rename(ctx.answersFilePath, `${ctx.answersFilePath}.1`);
      await writeFile(ctx.answersFilePath, '', 'utf8');

      // A post-rotation line appended to the fresh file must still be tailed.
      const second = answerLineFixture({ deliveryId: 'dlv_post_rot', gateId: 'g_f3' });
      await appendFile(ctx.answersFilePath, `${JSON.stringify(second)}\n`);

      const emitted = await ctx.doorbell!.waitForEvent(
        (e) => e.type === 'gate-answer' && e['deliveryId'] === 'dlv_post_rot',
        6000,
      );
      expect(emitted).toMatchObject({ type: 'gate-answer', gateId: 'g_f3' });
    });
  });
});
