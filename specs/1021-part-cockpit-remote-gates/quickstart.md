# Quickstart: Cockpit Remote Gates — orchestrator operator guide

For operators and integrators (MCP tool authors, doorbell authors, on-call). All paths and env vars are as they land in the implement PR.

## What ships in this issue

- **3 HTTP routes** on the orchestrator's public Fastify port:
  - `POST /cockpit/gates` — open a gate.
  - `POST /cockpit/gates/:id/ack` — acknowledge a gate.
  - `POST /cockpit/answers` — receive a gate answer from cloud (relay-proxied).
- **1 relay channel**: `cluster.cockpit`.
- **1 on-disk artifact family**: `/workspaces/.generacy/cockpit/answers.ndjson` (+ rotated siblings).

## What does **not** ship

- The MCP tools that call the gate routes (separate issue).
- The doorbell that tails `answers.ndjson` (separate issue).
- The cloud-side inbox UI (separate cloud issue).

## Configuration

All env vars are read once at orchestrator boot in `packages/orchestrator/src/server.ts`.

| Env var | Default | Purpose |
|---|---|---|
| `COCKPIT_INTERNAL_API_KEY` | *(unset — routes reject 401 with warn on boot)* | Bearer key `authMiddleware` uses to gate `/cockpit/*`. Same delivery model as `ORCHESTRATOR_INTERNAL_API_KEY` (#598): entrypoint writes to a shared file, MCP + relay reads back. |
| `COCKPIT_ANSWERS_FILE` | `/workspaces/.generacy/cockpit/answers.ndjson` | Full path to the current answers file. Parent dir auto-created (`mode 0755`) on boot. |
| `COCKPIT_ANSWERS_ROTATION_BYTES` | `33554432` (32 MiB) | Rotation size threshold. |
| `COCKPIT_ANSWERS_ROTATION_KEEP` | `3` | Number of rotated siblings kept (`.1` through `.N`). |
| `COCKPIT_RETAIN_MAX_COUNT` | `1000` | FIFO count cap for offline retention. |
| `COCKPIT_RETAIN_MAX_BYTES` | `4194304` (4 MiB) | FIFO byte cap for offline retention. |

## Local smoke test (in-cluster)

Assumes the cluster is running and `COCKPIT_INTERNAL_API_KEY` is set inside the orchestrator container.

```bash
# 1. Open a gate.
curl -sX POST http://127.0.0.1:3100/cockpit/gates \
  -H "Authorization: Bearer $COCKPIT_INTERNAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "kind":"gate-open",
    "gateId":"g_smoke_001",
    "generation":0,
    "scope":{"owner":"generacy-ai","repo":"generacy","issueNumber":1021},
    "openedAt":"2026-07-21T15:04:05.123Z",
    "payload":{"question":"proceed?"}
  }'
# → {"accepted":true,"retained":false}

# 2. Ack the gate.
curl -sX POST http://127.0.0.1:3100/cockpit/gates/g_smoke_001/ack \
  -H "Authorization: Bearer $COCKPIT_INTERNAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "kind":"gate-ack",
    "generation":0,
    "outcome":"answered",
    "ackedAt":"2026-07-21T15:04:11.900Z",
    "answer":{"choice":"proceed"}
  }'
# → {"accepted":true,"retained":false}

# 3. Simulate a cloud-side answer.
curl -sX POST http://127.0.0.1:3100/cockpit/answers \
  -H "Authorization: Bearer $COCKPIT_INTERNAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "kind":"gate-answer",
    "deliveryId":"dlv_smoke_001",
    "gateId":"g_smoke_001",
    "generation":0,
    "answeredAt":"2026-07-21T15:04:11.100Z",
    "answer":{"choice":"proceed"}
  }'
# → {"accepted":true,"deduped":false}

# 4. Same answer again — dedup path.
curl -sX POST http://127.0.0.1:3100/cockpit/answers \
  -H "Authorization: Bearer $COCKPIT_INTERNAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"kind":"gate-answer","deliveryId":"dlv_smoke_001","gateId":"g_smoke_001","generation":0,"answeredAt":"2026-07-21T15:04:11.100Z","answer":{"choice":"proceed"}}'
# → {"accepted":true,"deduped":true}

# 5. Inspect the answers file.
tail -n 5 /workspaces/.generacy/cockpit/answers.ndjson
```

## Verifying `cluster.cockpit` emission

The relay events land on the cloud subscriber. To observe them cluster-side, tail the orchestrator logs and look for the send/enqueue path:

```bash
docker compose logs -f orchestrator | grep -Ei 'cluster.cockpit|retain'
```

Log surface added by this issue:

- `debug` — `retained cockpit event queued` (per enqueue).
- `info` — `cockpit gate emitted { gateId, kind }` (per successful send).
- `warn` — `cluster.cockpit retain queue overflow { dropped, reason }` (rate-limited).
- `warn` — `COCKPIT_INTERNAL_API_KEY not set — cockpit gate routes will reject all requests` (boot).
- `info` — `cockpit-answers-rotated { keptSiblings }` (per rotation).

## Troubleshooting

**`401` on a gate route.** `COCKPIT_INTERNAL_API_KEY` is unset in the orchestrator env, or the caller's `Authorization` header is missing/wrong. Check `docker compose exec orchestrator env | grep COCKPIT_INTERNAL_API_KEY`. If the cluster-base entrypoint hasn't written the shared key file yet, this is a startup-order bug in the companion PR — file against cluster-base.

**Events flow while connected but never arrive on the cloud after a reconnect.** Check the retain queue overflow logs — a burst of events during a long outage may have been dropped. Bump `COCKPIT_RETAIN_MAX_COUNT` and `COCKPIT_RETAIN_MAX_BYTES` for the affected cluster.

**`answers.ndjson` isn't rotating.** Confirm `COCKPIT_ANSWERS_ROTATION_BYTES` is small enough to trip on your test volume. Confirm the writer has write permission on `/workspaces/.generacy/cockpit/` — a stale root-owned directory from a prior manual `mkdir` is the usual cause; `chown -R node:node /workspaces/.generacy/cockpit`.

**Duplicate lines in `answers.ndjson`.** The writer dedups by `deliveryId` for the current file only. If the cloud replays across an orchestrator restart *and* a rotation, duplicates targeting rotated siblings can slip through. Downstream consumers (doorbell) must be `deliveryId`-idempotent regardless.

**`503 ANSWERS_FILE_UNAVAILABLE` at boot.** The writer failed to `mkdir` or `open` its target. Check `/workspaces/.generacy/` mount permissions and orchestrator UID.

## Relay-proxied path (`POST /cockpit/answers`) — how it reaches the orchestrator

1. Cloud sends an `api_request` message on the relay WebSocket with `path: '/cockpit/answers'`.
2. Cluster-relay dispatcher iterates route entries in `initializeRelayBridge()` — none match `/cockpit/*`.
3. Falls through to the implicit `orchestratorUrl` handler at `packages/cluster-relay/src/proxy.ts:166-168`, which forwards `POST http://127.0.0.1:3100/cockpit/answers` with the full path preserved and the cloud's headers propagated.
4. Fastify serves the route via `setupCockpitAnswersRoute()`.

No route entry is needed in `initializeRelayBridge()`. This is a deliberate divergence from `/control-plane/*` and `/code-server/*` (which need explicit routing to Unix sockets); `/cockpit/answers` is served by the orchestrator itself, so the fallback is correct.

## When to reach out

If you're integrating a new MCP tool, doorbell consumer, or cloud subscriber:

- **Wire contract questions**: read `docs/cockpit-remote-gates-plan.md` in the tetrad-development repo (authoritative). Propose changes on the epic.
- **Orchestrator behavior questions**: read `specs/1021-part-cockpit-remote-gates/` on this branch (spec, clarifications, plan, contracts).
- **Something that used to work stops working**: `git log --oneline --all -- packages/orchestrator/src/routes/cockpit-*` and `git log --oneline --all -- packages/orchestrator/src/services/cockpit-answers-writer.ts`.
