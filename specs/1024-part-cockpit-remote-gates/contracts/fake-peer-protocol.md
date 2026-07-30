# Contract — Fake relay peer protocol

**Purpose**: Pin the exact WebSocket message frames the harness's fake peer exchanges with the real orchestrator, so P2 (generacy-cloud) can implement its fake-cluster tests emitting and expecting the same bytes.

**Wire framing**: All messages are JSON-encoded WebSocket text frames matching `RelayMessageSchema` from `@generacy-ai/cluster-relay/messages`. No custom framing, no compression.

**Transport**: `ws://127.0.0.1:<random-port>`. TLS not used (test-only). Same URL passed as `config.relay.relayUrl` to the orchestrator.

## Connection lifecycle

1. **Orchestrator connects** → `ClusterRelay.connect()` dials `ws://127.0.0.1:<port>` and sends a `handshake` frame:
   ```jsonc
   {
     "type": "handshake",
     "metadata": {
       "workers": 0,
       "activeWorkflows": 0,
       "channel": "preview",
       "orchestratorVersion": "test",
       "gitRemotes": [],
       "uptime": 0,
       "clusterId": "test-cluster"
     }
     // "activation" omitted — test env has a pre-populated apiKey
   }
   ```

2. **Fake peer responds** with a `heartbeat` frame to unblock the client's `authenticating → connected` transition (mirrors `packages/cluster-relay/tests/relay.test.ts:93-100`):
   ```jsonc
   { "type": "heartbeat" }
   ```

3. Steady state — the fake peer accepts inbound `event`, `api_response`, `heartbeat` frames and emits outbound `api_request` frames as scenarios require.

## Cluster → Cloud (inbound to the fake peer)

### Frame: `event` on channel `cluster.cockpit` (gate-open)

Emitted by the orchestrator when scenario S1a POSTs `/cockpit/gates`.

```jsonc
{
  "type": "event",
  "event": "cluster.cockpit",
  "timestamp": "2026-07-21T12:34:56.789Z",
  "data": {
    "kind": "gate-open",
    "gate": { /* GateOpen shape from @generacy-ai/cockpit/gates */ }
  }
}
```

**Note**: `data.kind` discriminator is expected because the `cluster.cockpit` channel carries **both** gate-open and outcome-ack events. Exact discriminator field name is set by #1021; the harness imports the discriminator constant from `@generacy-ai/cockpit/gates` rather than hard-coding it.

**Assertion (S1a / FR-003)**: `event.data.gate` is byte-equal (via `expect(...).toEqual(...)`) to the `GateOpen` object POSTed to `/cockpit/gates`.

### Frame: `event` on channel `cluster.cockpit` (outcome-ack)

Emitted by the orchestrator when scenario S3 POSTs `/cockpit/gates/:id/ack`.

```jsonc
{
  "type": "event",
  "event": "cluster.cockpit",
  "timestamp": "2026-07-21T12:34:56.789Z",
  "data": {
    "kind": "outcome",
    "outcome": { /* GateOutcome shape from @generacy-ai/cockpit/gates */ }
  }
}
```

**Assertion (S3 / FR-006)**: `event.data.outcome` is byte-equal to the `GateOutcome` object POSTed to the ack route.

### Frame: `api_response`

Emitted by the orchestrator in response to a fake-peer `api_request` (see below). Correlated by `correlationId`.

```jsonc
{
  "type": "api_response",
  "correlationId": "<same as request>",
  "status": 200,
  "body": {}  // may be empty for /cockpit/answers happy path
}
```

## Cloud → Cluster (outbound from the fake peer)

### Frame: `api_request` for `POST /cockpit/answers` (scenarios S2, S4, S5, F1)

Injected by the fake peer via `peer.sendApiRequest('POST', '/cockpit/answers', GateAnswer)`.

```jsonc
{
  "type": "api_request",
  "correlationId": "<uuid-v4>",
  "method": "POST",
  "path": "/cockpit/answers",
  "headers": { "content-type": "application/json" },
  "body": { /* GateAnswer shape from @generacy-ai/cockpit/gates */ }
}
```

**Expected orchestrator behavior** (asserted end-to-end):
1. Validates body against `GateAnswerSchema` — invalid → 4xx (asserted implicitly by scenarios NOT using invalid bodies; F1 tests malformed file-level, not the route).
2. Dedupes by `deliveryId` — same `deliveryId` seen twice → single file line (S5 / FR-008 layer a).
3. Appends one NDJSON line to `COCKPIT_ANSWERS_FILE`.
4. Returns `api_response` with `status: 200`.
5. The doorbell (child) tails the file and emits one `gate-answer` line on stdout.
6. The MCP event-bus registry (in-process) also surfaces a `gate-answer` typed entry.

**Assertion (S2 / FR-005)** — four side-effects in a single scenario:
```ts
const answer = answerLineFixture({ deliveryId: 'delivery-1', gateId, gateKey });
const resp = await peer.sendApiRequest('POST', '/cockpit/answers', answer);
expect(resp.status).toBe(200);                                              // (b)
const fileLines = (await readFile(answersFilePath, 'utf8')).trim().split('\n');
expect(fileLines).toHaveLength(1);                                          // (a)
const emitted = await doorbell.waitForEvent(e => e.type === 'gate-answer'); // (c)
expect(emitted).toMatchObject({ type: 'gate-answer', gateId });
const busBatch = await awaitCockpitEvents(sinceCursor);                     // (d)
expect(busBatch.entries.some(e => e.event.type === 'gate-answer')).toBe(true);
```

## Retain-and-replay (FR-004 / scenario S1b)

**Sequence**:
1. Peer accepts the initial orchestrator connection + handshake.
2. Test calls `peer.disconnectAllClients()` — forcibly terminates the client-side WebSocket.
3. Test POSTs a gate-open to the orchestrator via HTTP (`POST http://127.0.0.1:<orchestrator-port>/cockpit/gates`).
4. Orchestrator's `POST /internal/relay-events` detects `!client.isConnected` and retains the event (per the `cluster.vscode-tunnel` pattern in `routes/retained-tunnel-event.ts`).
5. Orchestrator's `ClusterRelay` reconnect loop dials the fake peer again — peer's `wss.on('connection', ...)` fires a second time.
6. Peer receives a fresh `handshake` frame + the retained `event` frame with `event: 'cluster.cockpit'` and identical `data`.

**Assertion**: `peer.received.events` after reconnect contains the gate-open event exactly once, byte-equal to the original POST body.

## Failure-mode contracts (F1–F3)

### F1 (FR-013): malformed answer NDJSON line

**Not** driven through the fake peer's `api_request` path (that would test route validation, which is FR-014's job). Instead, the harness writes garbage directly to `COCKPIT_ANSWERS_FILE`:

```ts
await appendFile(answersFilePath, 'this is not json\n');
// then via peer, send a valid answer
const answer = answerLineFixture({ deliveryId: 'delivery-after-garbage' });
await peer.sendApiRequest('POST', '/cockpit/answers', answer);
// assert doorbell still emits the valid one
const emitted = await doorbell.waitForEvent(e => e.type === 'gate-answer' && e.deliveryId === 'delivery-after-garbage');
expect(doorbell.stdoutLines.some(l => l.includes('malformed'))).toBe(true); // log expected
```

### F2 (FR-014): invalid gate-open body

Direct HTTP POST bypassing the peer (peer never sees an event because the route rejects before the emitter runs):

```ts
const resp = await fetch(`${orchestratorUrl}/cockpit/gates`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ /* missing required fields */ }),
});
expect(resp.status).toBeGreaterThanOrEqual(400);
expect(resp.status).toBeLessThan(500);
// assert peer received no event
await sleep(200); // grace window
expect(peer.received.events.filter(e => e.event === 'cluster.cockpit')).toHaveLength(0);
```

### F3 (FR-015): answers-file rotation

```ts
// 1. inject an answer through the peer, don't ack yet
const answer = answerLineFixture({ deliveryId: 'delivery-pre-rotation' });
await peer.sendApiRequest('POST', '/cockpit/answers', answer);
await doorbell.waitForEvent(e => e.deliveryId === 'delivery-pre-rotation');
// 2. rotate the file
await rename(answersFilePath, `${answersFilePath}.1`);
await writeFile(answersFilePath, '', 'utf8');
// 3. inject a second answer through the peer
const answer2 = answerLineFixture({ deliveryId: 'delivery-post-rotation' });
await peer.sendApiRequest('POST', '/cockpit/answers', answer2);
// 4. doorbell must still surface the second answer
await doorbell.waitForEvent(e => e.deliveryId === 'delivery-post-rotation');
```

## Non-contracts (explicitly deferred)

- Authentication: fake peer skips API-key validation. The real cloud validates against the cluster's activation key; the harness's `apiKey: 'test-key'` config is not verified by the peer.
- Real WSS/TLS: `ws://` only.
- Reconnect backoff: uses the orchestrator's own `ClusterRelay` config; harness overrides `baseReconnectDelayMs` and `maxReconnectDelayMs` to low values (~50 ms / 200 ms) so retain-and-replay observes within scenario timeouts.
- Multi-cluster: single fake peer per scenario; no cluster-fan-out testing.
