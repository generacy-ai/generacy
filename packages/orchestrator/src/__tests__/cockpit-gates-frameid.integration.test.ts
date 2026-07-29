/**
 * #1066 — wire-level frameId placement (SC-001, load-bearing).
 *
 * Composes the REAL cluster-side gate surface end-to-end against a fake relay
 * peer (pattern from `cockpit-gates-integration.integration.test.ts` /
 * `packages/cluster-relay/tests/relay.test.ts`) and pins the exact byte
 * position of `frameId` on the outbound frame.
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
import { gateOpenFixture } from '@generacy-ai/cockpit';
import {
  setupScenario,
  waitFor,
  type ScenarioContext,
} from './cockpit-gates/scenario-helpers.js';

const JSON_HEADERS = { 'content-type': 'application/json' };
const gid = (hexTag: string): string => hexTag.padEnd(24, '0');
const GID_WITH = gid('f10611dd');
const GID_WITHOUT = gid('f10600dd');

describe('#1066 wire-level frameId placement', () => {
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

  it('gate-open POST without frameId → peer sees no frameId inside data', async () => {
    const body = gateOpenFixture({ gateId: GID_WITHOUT });
    const res = await fetch(`${ctx.orchestratorUrl}/cockpit/gates`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);

    const received = await ctx.peer.waitForEvent(
      'cluster.cockpit',
      (d) => (d as { gateId?: string }).gateId === GID_WITHOUT,
    );
    expect(Object.hasOwn(received.data as object, 'frameId')).toBe(false);
  });
});
