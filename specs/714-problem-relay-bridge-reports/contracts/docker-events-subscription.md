# Contract: Docker Engine `/events` subscription

## Endpoint

```
GET /events HTTP/1.1
Host: docker
```

over the orchestrator's existing Unix socket (`DOCKER_HOST` env var, default `unix:///var/run/docker-host.sock`).

## Query string

The subscription must use a `filters` query parameter whose value is the URL-encoded JSON object:

```json
{
  "label": [
    "com.docker.compose.project=<resolved-project-name>",
    "com.docker.compose.service=worker"
  ],
  "type": ["container"]
}
```

`<resolved-project-name>` is the value returned by `computeProjectName(engineClient)` at `RelayBridge.start()`. If `computeProjectName` throws `ORCHESTRATOR_NOT_COMPOSE_MANAGED`, the subscription is **not** opened — the orchestrator is running outside compose and there are no worker containers to watch. The next periodic heartbeat (which calls `collectMetadata()`) will continue to fail-and-omit, which is correct.

## Response

The Docker daemon returns `Content-Type: application/json` and streams newline-delimited JSON objects until the client disconnects or the daemon exits. No final byte / no Content-Length.

Each line is one event:

```json
{
  "Type": "container",
  "Action": "die",
  "id": "<container-id>",
  "Actor": {
    "ID": "<container-id>",
    "Attributes": {
      "name": "<project>-worker-1",
      "com.docker.compose.project": "<project>",
      "com.docker.compose.service": "worker",
      "exitCode": "0",
      "image": "..."
    }
  },
  "scope": "local",
  "time": 1716499200,
  "timeNano": 1716499200000000000
}
```

## Trigger actions

Fire `RelayBridge.sendMetadata()` on `Action ∈ { "create", "start", "die", "destroy" }`.

- `create` — container created but not yet started. We include it so a brief "creating" UI signal isn't missed; the running count won't change yet but on the next periodic enumeration we may want a fresh reading anyway.
- `start` — container transitions to `running`. Count goes up by 1.
- `die` — container exits (whether successfully or not). Count goes down by 1.
- `destroy` — container removed entirely. Count goes down by 1 if it was still present; no-op if `die` already fired.

Other actions (`pause`, `unpause`, `kill`, `oom`, `restart`, `update`, etc.) are observed but **not** acted on — `kill` is followed by `die`; `restart` is followed by `start`. Filtering server-side on `event:` is possible but more error-prone than client-side dispatch.

## Reconnect behavior

The HTTP stream is long-lived but not infinite. The daemon may:

- Close the socket on its own restart.
- Drop the connection if the docker socket gets re-bound (rare).
- Hit a transient TCP/Unix socket error.

The subscriber must:

1. Catch any error / EOF from the stream.
2. Wait `backoffMs` (initial 5000, double on consecutive failures, capped at 60_000).
3. Re-open the subscription with the same filter.
4. Reset `backoffMs` to 5000 the moment the new stream delivers any byte (or stays open for ≥30s).

The reconnect loop terminates when `RelayBridge.stop()` aborts the controller.

## Cancellation

`RelayBridge.stop()` calls `workerEventAbort.abort()`. The async iterator returned by `streamContainerEvents` must:

- Stop yielding events.
- Destroy the underlying socket.
- Return from any pending `for await` loop in the consumer.

The reconnect timer (`workerEventReconnectTimer`) must also be cleared in `stop()`.

## Error semantics

Errors **observed** by the subscriber:

| Cause | Handling |
|---|---|
| `ECONNREFUSED` / `ENOENT` on the socket path | Log `warn` once per backoff cycle, reconnect. Do not crash. |
| HTTP non-200 response (rare; usually `400` on a bad filter) | Log `error`, stop trying. This is a programming error. |
| Stream cleanly ends (daemon restart) | Log `info`, reconnect. |
| Malformed JSON line | Log `warn` with the offending bytes, skip the line, continue reading. |
| `AbortError` from the controller | Suppress; this is expected on shutdown. |

Errors **propagated** to `sendMetadata()`:

None. `sendMetadata()` already has its own try/catch (`collectMetadata()` failures don't crash the heartbeat); a transient Engine API hiccup during a triggered send just means the next heartbeat will pick up the change ≤60s later.

## Conformance test cases

The orchestrator integration test will assert:

1. **Trigger fires** — `streamContainerEvents` yields a `{ Action: 'die' }` event → `sendMetadata()` is called within 100ms of the yield.
2. **Filter shape** — the query string passed to the engine includes both labels and `type: ["container"]`.
3. **Cancellation** — calling `stop()` aborts the controller; the async iterator returns; no further `sendMetadata()` calls after `stop()` resolves.
4. **Reconnect** — when the test harness closes the upstream socket, the subscriber reconnects within `backoffMs + ε`.
5. **Backoff cap** — five consecutive immediate failures result in a 60_000ms delay before the sixth attempt, not 80_000ms.
