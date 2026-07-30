# Research: Cockpit Remote Gates — orchestrator side

## 1. Retention semantics for `cluster.cockpit`

**Decision**: Bounded FIFO queue with count **and** byte caps, drop-oldest with a `warn` log on overflow. No dedup — the cloud upserts by `gateId`.

**Alternatives considered** (from clarifications.md Q1):

- **Single-slot mirror of `retained-tunnel-event.ts`** — literal "same pattern" reading. Rejected: multi-gate sequences (ack-A then open-B during outage) would drop the ack.
- **Per-`gateId` slot map with ordered index** — folds ack over open, discards intermediates. Rejected: the cloud already upserts by `gateId`, so per-gate slotting is redundant, and intermediates (multiple opens for the same gateId — impossible today but not schema-forbidden) would be silently lost.
- **Chosen: FIFO** — matches FR-005 (order preservation + replay) and FR-014 (bounded, drop-oldest) exactly.

**Why not merge `retained-tunnel-event.ts` and `retained-cockpit-events.ts` into a shared module?**
- The tunnel module is single-slot with terminal/pending status semantics. The cockpit module is a bounded FIFO. They share ~zero code.
- Merging would introduce a `RetentionMode` enum and dispatch cost for negative benefit. Keep separate; both are ~50-line files.

**Reference**: `packages/orchestrator/src/routes/retained-tunnel-event.ts:1-94` (single-slot pattern to *not* copy).

**Cap defaults** (subject to tuning at implement time):
- `COCKPIT_RETAIN_MAX_COUNT` = 1000 events.
- `COCKPIT_RETAIN_MAX_BYTES` = 4 MiB (JSON.stringify sum of `data` payloads).
- On overflow, drop-oldest until under both caps; emit `logger.warn({ dropped: n, reason: 'count' | 'bytes' }, 'cluster.cockpit retain queue overflow')`.

## 2. Answers-file rotation retention

**Decision**: Keep N most-recent rotated files (N=3 default, `COCKPIT_ANSWERS_ROTATION_KEEP` env).

**Alternatives considered** (from clarifications.md Q2):

- **Total-on-disk size cap** — bounded but harder to reason about with variable line sizes. Rejected: doorbell needs a *count* window, not a byte window.
- **Keep-all** — zero-drop guarantee, unbounded disk. Rejected: server-side outages could accumulate GB.
- **Keep-one predecessor** — minimal footprint. Rejected: two rotations while doorbell is down = unrecoverable data loss for the doorbell.
- **Chosen: N=3** — safe catch-up window at ~3× threshold disk (~96 MiB with default 32 MiB threshold), reader dedup by `deliveryId` makes overlap harmless.

**Rotation algorithm** (per Q2 rationale):

```
On threshold cross:
  1. If exists(answers.ndjson.N): unlink(answers.ndjson.N)
  2. For i from N-1 downto 1:
       If exists(answers.ndjson.i): rename(answers.ndjson.i, answers.ndjson.(i+1))
  3. rename(answers.ndjson, answers.ndjson.1)
  4. Open new answers.ndjson (mode 0644), reset in-memory byte counter.
```

Runs under the per-writer append mutex — no concurrent appender can race the rename.

## 3. `deliveryId` cross-restart dedup

**Decision**: On `writer.init()`, scan `answers.ndjson` (current file only) line-by-line and populate an in-memory `Set<string>`. Rotated siblings not scanned.

**Alternatives considered** (from clarifications.md Q3):

- **Scan all rotations** — bounded boot cost, marginal correctness gain since the doorbell/cloud replay is authoritative for rotated content. Rejected as over-scoping.
- **Sidecar dedup file** — constant-time lookup, larger surface, requires its own rotation. Rejected: adds a second failure domain for the same job the reader already does.
- **In-memory only, no boot scan** — matches Assumptions literally. Rejected: reconnect-redelivery is a real scenario (cloud retries when relay reconnects mid-request) and duplicates within seconds of restart would slip through.
- **Chosen: scan current only** — cheap in the common case (a few KiB), correct for the common failure mode (reconnect-redelivery targeting recent answers).

**Boot-scan implementation**:
- Stream via `readline` over `fs.createReadStream(path)`. Parse each line as JSON; skip malformed lines (log at `warn`, do not throw).
- Populate `Set<string>` keyed by `deliveryId`. On completion, log `{ dedupSetSize }` at `info`.
- If file doesn't exist yet, no-op (empty set, ready to append).

## 4. Localhost enforcement for gate routes

**Decision**: API-key layer via existing `apiKeyStore`, new `COCKPIT_INTERNAL_API_KEY` env var.

**Alternatives considered** (from clarifications.md Q4):

- **Bind to Unix socket** — strongest boundary, heavy for two routes. Rejected.
- **Loopback IP guard** — can't distinguish MCP-local from relay-proxied (both are 127.0.0.1). Rejected.
- **No enforcement** — accepts any in-cluster caller. Rejected: cluster network is not a security boundary in v1.5.
- **Chosen: API-key layer** — reuses `authMiddleware` (already covers all routes not in `skipRoutes`), matches `ORCHESTRATOR_INTERNAL_API_KEY` precedent from #598.

**Wiring** (see `packages/orchestrator/src/server.ts:780-790` for the parallel `ORCHESTRATOR_INTERNAL_API_KEY` block):

```typescript
const cockpitKey = process.env['COCKPIT_INTERNAL_API_KEY'];
if (cockpitKey) {
  apiKeyStore.addKey(cockpitKey, {
    name: 'cockpit-internal',
    scopes: ['admin'],
    createdAt: new Date().toISOString(),
  });
} else {
  server.log.warn(
    'COCKPIT_INTERNAL_API_KEY not set — cockpit gate routes will reject all requests',
  );
}
```

**MCP-side key delivery**: the in-cluster MCP server reads the key from a shared file (same shape as `ORCHESTRATOR_INTERNAL_API_KEY` file delivery in the cluster-base entrypoint). Cluster-base companion PR wires that; this issue only needs the orchestrator to accept the header. Sentinel path documented in `quickstart.md`.

## 5. Relay routing for `POST /cockpit/answers`

**Decision**: Implicit `orchestratorUrl` fallback; no route entry in `initializeRelayBridge()`.

**Alternatives considered** (from clarifications.md Q5):

- **Explicit `/cockpit` prefix with strip** — requires renaming the Fastify route to `/answers` (prefix is stripped by dispatcher). Rejected: `/answers` on the orchestrator would be surprising and clash-prone.
- **Explicit `/cockpit/answers` no-strip** — requires a dispatcher shape change. Rejected: new codepath for a case the fallback already handles.
- **Chosen: fallback** — confirmed at `packages/cluster-relay/src/proxy.ts:166-168`:

  ```typescript
  } else {
    const url = `${config.orchestratorUrl}${request.path}`;
    result = await forwardToHttp(url, request.method, headers, body, config.requestTimeoutMs);
  }
  ```

Nothing else in `initializeRelayBridge()` claims `/cockpit/*`, so the fallback wins.

## 6. Wire-shape and channel allow-list

**Confirmed** against `packages/orchestrator/src/routes/internal-relay-events.ts:9-15`:

```typescript
const ALLOWED_CHANNELS = [
  'cluster.vscode-tunnel',
  'cluster.audit',
  'cluster.credentials',
  'cluster.bootstrap',
  'cluster.identity-split',
] as const;
```

Add `'cluster.cockpit'` here — one-line change, no structural refactor.

**EventMessage shape** (confirmed at `internal-relay-events.ts:48-53`, post-#600 fix):

```typescript
client.send({ type: 'event', event, data, timestamp });
```

Matches the wire the cloud already consumes for `cluster.credentials`, `cluster.bootstrap`, etc.

## 7. Answers-file location

**Decision**: `/workspaces/.generacy/cockpit/answers.ndjson` (default), `COCKPIT_ANSWERS_FILE` override.

**Rationale**:
- `/workspaces/.generacy/` is the workspace-side mirror path (referenced by the smee-channel resolver, per exploration §8) and is guaranteed to exist as a mount point in cluster containers.
- `/cockpit/answers.ndjson` under that root keeps the file colocated with future cockpit workspace artifacts (task logs, gate snapshots) so `find /workspaces/.generacy/cockpit -type f` remains a useful debug primitive.
- Env override lets tests point at a temp dir without touching the singleton.

**Directory bootstrap**: `fs.mkdir(dirname, { recursive: true, mode: 0o755 })` on `writer.init()`. Same pattern as the smee workspace mirror creates its dir.

## 8. Test seams

- `CockpitAnswersWriter` takes its path + rotation caps via constructor options. Env-var reads happen only in `server.ts`.
- `RetainedCockpitEvents` takes caps via constructor options. Tests can shrink caps to trivial values to exercise overflow paths in one call each.
- Route handlers take `{ writer, retainer, getRelayClient }` as an options bag — no module-scope singletons in the route files (matches the dep-injection pattern in `setupInternalRelayEventsRoute`).

## 9. Failure modes and observability

| Failure | Behavior | Log level |
|---|---|---|
| `GateOpenSchema.parse` fails | `400 { error, code: 'VALIDATION', details: zodError.issues }` | `warn` with `{ route, code }` |
| `GateAckSchema.parse` fails or path/body `gateId` mismatch | `400 { error, code: 'VALIDATION', details }` | `warn` |
| `GateAnswerSchema.parse` fails | `400 { error, code: 'VALIDATION', details }`; **nothing written** | `warn` |
| Relay client null (post-listen, pre-connect) | Enqueue into retain queue; respond `202` | `debug` per event |
| Retain queue overflow | Drop-oldest; respond `202` for the new event | `warn` once per overflow burst (rate-limited) |
| Answers file `EACCES` on `open` | `503 { error, code: 'ANSWERS_FILE_UNAVAILABLE' }` | `error`, one-shot at startup |
| Rotation `EACCES` on rename | Log error, keep appending to current file (over-cap); the next successful rotation catches up | `error` |
| `deliveryId` collision within a run | `200 { accepted: true, deduped: true }`; **nothing written** | `debug` |

## 10. References

- Spec: `specs/1021-part-cockpit-remote-gates/spec.md`
- Clarifications: `specs/1021-part-cockpit-remote-gates/clarifications.md`
- Epic wire contracts: `docs/cockpit-remote-gates-plan.md` in the tetrad-development repo (external — treated as authoritative for schema field lists).
- Prior art in this repo:
  - `packages/orchestrator/src/routes/internal-relay-events.ts` (post-#598, #600) — auth + wire shape
  - `packages/orchestrator/src/routes/retained-tunnel-event.ts` — single-slot pattern (do *not* copy)
  - `packages/orchestrator/src/services/relay-bridge.ts:227-245` — replay-on-connect hook
  - `packages/orchestrator/src/server.ts:780-790` — `ORCHESTRATOR_INTERNAL_API_KEY` registration block
  - `packages/orchestrator/src/server.ts:1338-1347` — relay-bridge `routes` array
  - `packages/cluster-relay/src/proxy.ts:141-195` — dispatcher + fallback
- Related recent work per CLAUDE.md: #574 (control-plane route), #586 (code-server route), #594/#598/#600 (internal-relay-events wire).
