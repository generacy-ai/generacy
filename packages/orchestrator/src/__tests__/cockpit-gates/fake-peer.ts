/**
 * Fake relay peer for the cockpit gates integration harness (#1024).
 *
 * A thin WebSocketServer wrapper that speaks the existing `RelayMessageSchema`
 * discriminated union from `@generacy-ai/cluster-relay`. Used by
 * `cockpit-gates-integration.integration.test.ts` to compose the real
 * orchestrator + real doorbell child process against a controllable peer
 * that plays the role of the generacy-cloud relay ingress.
 *
 * Pattern mirrors `packages/cluster-relay/tests/relay.test.ts` — random port
 * via `WebSocketServer({ port: 0 })`, heartbeat-on-handshake to advance the
 * client's state machine, `waitFor` polling helper.
 *
 * See `specs/1024-part-cockpit-remote-gates/contracts/fake-peer-protocol.md`
 * and `specs/1024-part-cockpit-remote-gates/data-model.md` §"FakePeer" for
 * the pinned wire protocol.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import {
  RelayMessageSchema,
  type ApiResponseMessage,
  type EventMessage,
  type HandshakeMessage,
  type RelayMessage,
} from '@generacy-ai/cluster-relay';
import {
  GateOpenWireSchema,
  GateOutcomeWireSchema,
  type GateOpenWire,
  type GateOutcomeWire,
} from '../../../../generacy/src/cli/commands/cockpit/mcp/gates/schemas.js';

/** #1068 — parsed payload for cluster.cockpit frames whose payload schema passes.
 *  `runId` is stripped by `GateOpenWireSchema` (the frozen wire has no such
 *  field); the fake-peer copies it from the raw payload before invoking the
 *  callback so the fake-cloud store can key by it. */
export type ValidatedCockpitFrame =
  | { type: 'gate-open'; data: GateOpenWire & { runId?: string } }
  | { type: 'gate-outcome'; data: GateOutcomeWire };

/** #1068 — payload-validator violation record. */
export interface PayloadViolation {
  frameType: 'gate-open' | 'gate-outcome' | 'unknown';
  gateId?: string;
  issues: unknown;
}

export interface FakePeerOptions {
  /** WebSocket port; default 0 (random). */
  port?: number;
  /** Custom responder for api_request frames the peer sends TO the cluster.
   *  Currently unused — the harness's api_requests are proxied by the
   *  orchestrator to its own routes; peer waits for correlated api_response
   *  frames coming back over the wire. Kept for future symmetry. */
  apiRequestHandler?: (
    req: Extract<RelayMessage, { type: 'api_request' }>,
  ) => Promise<Partial<ApiResponseMessage>>;
  /**
   * #1068 — invoked on every `cluster.cockpit` frame whose payload passes the
   * frozen wire-schema check. Used by the #1068 harness to route validated
   * frames into a `FakeCloudStore`. Errors thrown by the callback are logged
   * but never crash the peer.
   */
  onValidatedFrame?: (frame: ValidatedCockpitFrame) => void;
}

export interface FakePeer {
  /** ws://127.0.0.1:<port> — pass to orchestrator config.relay.relayUrl. */
  readonly url: string;

  /** Cumulative record of everything received across all connections. */
  readonly received: {
    events: EventMessage[];
    apiResponses: ApiResponseMessage[];
    handshakes: HandshakeMessage[];
  };

  /**
   * #1068 — payload-validator violations on cluster.cockpit frames. Frames that
   * fail `GateOpenWireSchema` / `GateOutcomeWireSchema.safeParse` are tracked
   * here AND deliberately excluded from `received.events`. The peer stays
   * connected on failure so unrelated tests in the same file keep running.
   */
  readonly payloadViolations: ReadonlyArray<PayloadViolation>;

  /**
   * Wait until an event on the named channel arrives (or reject on timeout).
   * Optional `matcher` narrows the match (e.g. by gateId inside `data`).
   */
  waitForEvent(
    channel: string,
    matcher?: (data: unknown) => boolean,
    timeoutMs?: number,
  ): Promise<EventMessage>;

  /**
   * Send an api_request to the currently connected cluster client, resolving
   * with the matching api_response frame (correlated on `correlationId`).
   */
  sendApiRequest(
    method: string,
    path: string,
    body: unknown,
    timeoutMs?: number,
  ): Promise<ApiResponseMessage>;

  /**
   * Send a raw JSON frame to every currently-connected client. #1077 uses this
   * to echo a `cluster.cockpit.reply` frame back after receiving a
   * `cluster.cockpit` event, exercising the pending-map settle/quiet-drop path.
   */
  sendRawToClusters(frame: unknown): void;

  /** Force-drop all currently connected clients (FR-004 disconnect). */
  disconnectAllClients(): Promise<void>;

  /** Resolve on the next new client connection (FR-004 reconnect). */
  waitForReconnect(timeoutMs?: number): Promise<void>;

  /** Idempotent shutdown of the ws server. */
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 20;

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  message: () => string,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(message());
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

/**
 * Start a fake peer on the given (or random) port. The returned handle owns
 * the WebSocketServer lifecycle — call `close()` in `afterEach`.
 */
export async function startFakePeer(opts: FakePeerOptions = {}): Promise<FakePeer> {
  const wss = new WebSocketServer({ port: opts.port ?? 0 });
  await once(wss, 'listening');
  const addr = wss.address() as AddressInfo;
  const url = `ws://127.0.0.1:${addr.port}`;

  const received: FakePeer['received'] = {
    events: [],
    apiResponses: [],
    handshakes: [],
  };

  // #1068 — payload-validator violations. Mutable internally; exposed as
  // readonly on the FakePeer surface.
  const payloadViolations: PayloadViolation[] = [];

  // correlationId → resolver for outbound api_request awaits
  const pendingApiRequests = new Map<
    string,
    (response: ApiResponseMessage) => void
  >();

  let currentClient: WsWebSocket | null = null;
  let reconnectWaiters: Array<() => void> = [];

  wss.on('connection', (ws) => {
    currentClient = ws;
    for (const resolve of reconnectWaiters) resolve();
    reconnectWaiters = [];

    ws.on('message', (raw) => {
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString());
      } catch (err) {
        // Test-only: log and drop malformed frames rather than crash.
        // eslint-disable-next-line no-console
        console.warn('[fake-peer] dropping non-JSON frame:', err);
        return;
      }
      const parsed = RelayMessageSchema.safeParse(payload);
      if (!parsed.success) {
        // Test-only diagnostic — the peer never crashes on unknown frames.
        // eslint-disable-next-line no-console
        console.warn(
          '[fake-peer] dropping frame that failed RelayMessageSchema.safeParse:',
          parsed.error.issues,
        );
        return;
      }
      const msg = parsed.data;
      if (msg.type === 'handshake') {
        received.handshakes.push(msg);
        // Advance the client from authenticating → connected (mirrors the
        // pattern in `packages/cluster-relay/tests/relay.test.ts:93-100`).
        ws.send(JSON.stringify({ type: 'heartbeat' }));
        return;
      }
      if (msg.type === 'event') {
        // #1068 — payload-shape validation for the cluster.cockpit channel.
        // The envelope validator (RelayMessageSchema) only requires `data` to
        // be present; it does NOT inspect the payload. Real cloud parses via
        // GateOpenPayloadSchema / GateOutcomePayloadSchema and warn-drops on
        // failure — we mirror that here so a cluster-side wire drift (the
        // class of bug that shipped `frameId` inert) fails locally rather than
        // silently passing.
        if (msg.event === 'cluster.cockpit') {
          const dataObj = msg.data as { type?: unknown; gateId?: unknown } | null;
          const dataType =
            dataObj != null && typeof dataObj === 'object'
              ? dataObj.type
              : undefined;

          if (dataType === 'gate-open') {
            const parsedPayload = GateOpenWireSchema.safeParse(msg.data);
            if (!parsedPayload.success) {
              payloadViolations.push({
                frameType: 'gate-open',
                ...(typeof dataObj?.gateId === 'string'
                  ? { gateId: dataObj.gateId }
                  : {}),
                issues: parsedPayload.error.issues,
              });
              return; // deliberately NOT pushed to received.events
            }
            received.events.push(msg);
            if (opts.onValidatedFrame != null) {
              try {
                // Preserve `runId` from the raw payload — the wire schema
                // strips it (there is no runId field on GateOpenWireSchema)
                // but the fake-cloud store needs it to key correctly.
                const rawRunId = (dataObj as { runId?: unknown }).runId;
                const augmented: GateOpenWire & { runId?: string } =
                  typeof rawRunId === 'string' && rawRunId.length > 0
                    ? { ...parsedPayload.data, runId: rawRunId }
                    : parsedPayload.data;
                opts.onValidatedFrame({ type: 'gate-open', data: augmented });
              } catch (err) {
                // Test-only: log and continue; the peer never crashes on callback failure.
                // eslint-disable-next-line no-console
                console.warn('[fake-peer] onValidatedFrame threw on gate-open:', err);
              }
            }
            return;
          }

          if (dataType === 'gate-outcome') {
            const parsedPayload = GateOutcomeWireSchema.safeParse(msg.data);
            if (!parsedPayload.success) {
              payloadViolations.push({
                frameType: 'gate-outcome',
                ...(typeof dataObj?.gateId === 'string'
                  ? { gateId: dataObj.gateId }
                  : {}),
                issues: parsedPayload.error.issues,
              });
              return;
            }
            received.events.push(msg);
            if (opts.onValidatedFrame != null) {
              try {
                opts.onValidatedFrame({ type: 'gate-outcome', data: parsedPayload.data });
              } catch (err) {
                // eslint-disable-next-line no-console
                console.warn('[fake-peer] onValidatedFrame threw on gate-outcome:', err);
              }
            }
            return;
          }

          // Non-string / absent `type` — track as unknown, do NOT push.
          if (typeof dataType !== 'string') {
            payloadViolations.push({
              frameType: 'unknown',
              issues: [
                { message: 'cluster.cockpit frame data missing a string `type` discriminator' },
              ],
            });
            return;
          }
          // Some other string `type` — fall through to preserve today's behaviour.
        }

        received.events.push(msg);
        return;
      }
      if (msg.type === 'api_response') {
        received.apiResponses.push(msg);
        const resolver = pendingApiRequests.get(msg.correlationId);
        if (resolver != null) {
          pendingApiRequests.delete(msg.correlationId);
          resolver(msg);
        }
        return;
      }
      // heartbeat, tunnel_*, lease_*, error, conversation — silently accept.
    });

    ws.on('close', () => {
      if (currentClient === ws) currentClient = null;
    });
  });

  const peer: FakePeer = {
    url,
    received,
    payloadViolations,

    async waitForEvent(channel, matcher, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const match = (e: EventMessage): boolean =>
        e.event === channel && (matcher == null || matcher(e.data));
      await waitFor(
        () => received.events.some(match),
        timeoutMs,
        () => {
          const seen = received.events.map((e) => e.event).join(', ') || '(none)';
          return `[fake-peer] waitForEvent('${channel}') timed out after ${timeoutMs}ms. Events seen: [${seen}]`;
        },
      );
      const found = received.events.find(match);
      if (found == null) {
        throw new Error(
          `[fake-peer] waitForEvent invariant violated: predicate satisfied but find returned undefined`,
        );
      }
      return found;
    },

    async sendApiRequest(method, path, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
      if (currentClient == null || currentClient.readyState !== WsWebSocket.OPEN) {
        throw new Error(
          `[fake-peer] sendApiRequest called with no connected client (readyState=${currentClient?.readyState ?? 'null'})`,
        );
      }
      const correlationId = randomUUID();
      const frame = {
        type: 'api_request' as const,
        correlationId,
        method,
        path,
        headers: { 'content-type': 'application/json' },
        body,
      };
      const responsePromise = new Promise<ApiResponseMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingApiRequests.delete(correlationId);
          reject(
            new Error(
              `[fake-peer] sendApiRequest '${method} ${path}' timed out after ${timeoutMs}ms (correlationId=${correlationId})`,
            ),
          );
        }, timeoutMs);
        pendingApiRequests.set(correlationId, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
      });
      currentClient.send(JSON.stringify(frame));
      return responsePromise;
    },

    sendRawToClusters(frame) {
      const serialized = JSON.stringify(frame);
      for (const client of wss.clients) {
        if (client.readyState === WsWebSocket.OPEN) {
          client.send(serialized);
        }
      }
    },

    async disconnectAllClients() {
      for (const client of wss.clients) {
        client.terminate();
      }
      currentClient = null;
    },

    waitForReconnect(timeoutMs = DEFAULT_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reconnectWaiters = reconnectWaiters.filter((w) => w !== resolver);
          reject(
            new Error(
              `[fake-peer] waitForReconnect timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        const resolver = (): void => {
          clearTimeout(timer);
          resolve();
        };
        reconnectWaiters.push(resolver);
      });
    },

    async close() {
      for (const [, resolver] of pendingApiRequests) {
        // Best-effort: unblock any pending awaits by rejecting synthetically.
        try {
          resolver({
            type: 'api_response',
            correlationId: 'closed',
            status: 0,
            body: { error: 'peer closed' },
          });
        } catch {
          /* ignore */
        }
      }
      pendingApiRequests.clear();
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };

  return peer;
}
