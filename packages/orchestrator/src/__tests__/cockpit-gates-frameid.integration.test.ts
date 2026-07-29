/**
 * #1066 — wire-level frameId placement (SC-001, load-bearing).
 * #1077 — extended with the mint + settle/quiet-drop round-trip.
 *
 * Composes the REAL cluster-side gate surface end-to-end against a fake relay
 * peer (pattern from `cockpit-gates-integration.integration.test.ts` /
 * `packages/cluster-relay/tests/relay.test.ts`) and pins the exact byte
 * position of `frameId` on the outbound frame plus the settle/drop behaviour
 * when the peer echoes `cluster.cockpit.reply`.
 *
 * The load-bearing assertion is at `received.data.frameId`, NOT
 * `received.frameId`. Envelope-level placement would ship the change inert
 * because the cloud reads the field from `data` at
 * services/api/src/services/relay/message-handler.ts:804.
 *
 * A `vi.fn()` echoing its own argument does not satisfy SC-001 — the frame
 * has to cross a real WebSocket and land at a peer's message handler.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gateOpenFixture, gateOutcomeFixture } from '@generacy-ai/cockpit';
import type { ClusterRelay } from '@generacy-ai/cluster-relay';
import {
  setupScenario,
  waitFor,
  type ScenarioContext,
} from './cockpit-gates/scenario-helpers.js';

const JSON_HEADERS = { 'content-type': 'application/json' };
const gid = (hexTag: string): string => hexTag.padEnd(24, '0');
const GID_WITH = gid('f10611dd');
const GID_WITHOUT = gid('f10600dd');
const GID_SETTLE = gid('f10650dd');
const GID_DROP = gid('f10660dd');
const GID_ACK = gid('f10670dd');

function sendReplyToCluster(
  peer: ScenarioContext['peer'],
  frame: {
    frameId: string | null;
    frameType: 'gate-open' | 'gate-outcome';
    gateId: string;
    accepted: boolean;
    reason?: string;
    priorStatus?: string;
  },
): void {
  peer.sendRawToClusters({
    type: 'cluster.cockpit.reply',
    timestamp: new Date().toISOString(),
    ...frame,
  });
}

describe('#1066 + #1077 wire-level frameId placement and reply correlation', () => {
  let ctx: ScenarioContext;

  beforeEach(async () => {
    ctx = await setupScenario({ relayReconnectMs: 1000 });
    await waitFor(
      () => ctx.relayClient.isConnected,
      3000,
      'relay client did not reach the fake peer before the POST',
    );
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  it('gate-open POST with frameId → peer sees data.frameId (not envelope)', async () => {
    const body = gateOpenFixture({ gateId: GID_WITH, frameId: 'frm_wire_known' });
    const res = await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);

    const received = await ctx.peer.waitForEvent(
      'cluster.cockpit',
      (d) => (d as { gateId?: string }).gateId === GID_WITH,
    );
    expect(received.event).toBe('cluster.cockpit');
    expect((received.data as { type?: string }).type).toBe('gate-open');
    expect((received.data as { frameId?: string }).frameId).toBe('frm_wire_known');
    // The frameId lives INSIDE data, never on the envelope. Envelope-level
    // placement is a no-op — the cloud never looks there.
    expect(Object.hasOwn(received, 'frameId')).toBe(false);
  });

  it('gate-open POST without frameId → peer sees a route-minted frm_-prefixed id inside data (#1077)', async () => {
    const body = gateOpenFixture({ gateId: GID_WITHOUT });
    const res = await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    const responseBody = (await res.json()) as { frameId?: string };
    expect(responseBody.frameId).toMatch(/^frm_[a-f0-9]{24}$/);

    const received = await ctx.peer.waitForEvent(
      'cluster.cockpit',
      (d) => (d as { gateId?: string }).gateId === GID_WITHOUT,
    );
    // #1077: after the route mint, every outbound frame carries a frameId.
    expect((received.data as { frameId?: string }).frameId).toBe(responseBody.frameId);
  });

  it('gate-open peer echo settles the pending frame (#1077)', async () => {
    const relay = ctx.relayClient as unknown as ClusterRelay;
    const before = relay._pendingFramesSizeForTests();
    const body = gateOpenFixture({ gateId: GID_SETTLE });
    const res = await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    const { frameId } = (await res.json()) as { frameId: string };
    expect(frameId).toMatch(/^frm_[a-f0-9]{24}$/);

    // The mint registered a pending entry.
    expect(relay._pendingFramesSizeForTests()).toBe(before + 1);

    // Wait for the peer to observe the outbound frame, then echo a reply.
    await ctx.peer.waitForEvent(
      'cluster.cockpit',
      (d) => (d as { gateId?: string }).gateId === GID_SETTLE,
    );
    sendReplyToCluster(ctx.peer, {
      frameId,
      frameType: 'gate-open',
      gateId: GID_SETTLE,
      accepted: true,
    });

    await waitFor(
      () => relay._pendingFramesSizeForTests() === before,
      3000,
      'pending map did not shrink after settle echo',
    );
  });

  it('gate-open peer echo with unknown frameId is quiet-dropped (#1077)', async () => {
    const relay = ctx.relayClient as unknown as ClusterRelay;
    const body = gateOpenFixture({ gateId: GID_DROP });
    const res = await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    const beforeReply = relay._pendingFramesSizeForTests();

    await ctx.peer.waitForEvent(
      'cluster.cockpit',
      (d) => (d as { gateId?: string }).gateId === GID_DROP,
    );

    // Echo with a bogus frameId → quiet drop; pending map unchanged.
    sendReplyToCluster(ctx.peer, {
      frameId: 'frm_ffffffffffffffffffffffff',
      frameType: 'gate-open',
      gateId: GID_DROP,
      accepted: false,
      reason: 'schema-invalid',
    });

    // Give the reply time to be processed, then verify the pending map size
    // is unchanged (the legitimate entry from the POST is still there).
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(relay._pendingFramesSizeForTests()).toBe(beforeReply);
  });

  it('gate-outcome POST + peer echo settles the pending frame (#1077)', async () => {
    const relay = ctx.relayClient as unknown as ClusterRelay;
    const ackBody = gateOutcomeFixture({ gateId: GID_ACK });
    const before = relay._pendingFramesSizeForTests();

    const res = await fetch(`${ctx.orchestratorUrl}/cockpit/gates/${GID_ACK}/ack`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(ackBody),
    });
    expect(res.status).toBe(202);
    const { frameId } = (await res.json()) as { frameId: string };
    expect(frameId).toMatch(/^frm_[a-f0-9]{24}$/);
    expect(relay._pendingFramesSizeForTests()).toBe(before + 1);

    await ctx.peer.waitForEvent(
      'cluster.cockpit',
      (d) =>
        (d as { gateId?: string }).gateId === GID_ACK &&
        (d as { type?: string }).type === 'gate-outcome',
    );
    sendReplyToCluster(ctx.peer, {
      frameId,
      frameType: 'gate-outcome',
      gateId: GID_ACK,
      accepted: true,
    });

    await waitFor(
      () => relay._pendingFramesSizeForTests() === before,
      3000,
      'pending map did not shrink after gate-outcome settle echo',
    );
  });
});
