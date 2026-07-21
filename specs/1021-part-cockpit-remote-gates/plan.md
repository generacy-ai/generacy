# Implementation Plan: Cockpit Remote Gates — orchestrator side

**Feature**: Orchestrator-side wire for the Cockpit Remote Gates epic — three routes (`POST /cockpit/gates`, `POST /cockpit/gates/:id/ack`, `POST /cockpit/answers`), the `cluster.cockpit` relay channel with retain-and-replay, and an append-only NDJSON answers-file writer with rotation.
**Branch**: `1021-part-cockpit-remote-gates`
**Status**: Complete

## Summary

The in-session cockpit MCP server needs a way to hand off human gates to a central inbox on generacy.ai *without* blocking the driving conversation. This issue implements the **cluster-side** endpoint of that path:

1. **Two localhost-callable routes** (`/cockpit/gates`, `/cockpit/gates/:id/ack`) that the in-cluster MCP posts to. Each validates the payload against the shared gate schemas in `packages/cockpit/src/gates/`, then re-emits the payload as a relay `event` on a new allow-listed channel `cluster.cockpit`. While the relay is disconnected, events go into a bounded FIFO retain queue and are replayed in insertion order on reconnect.
2. **One relay-proxied route** (`/cockpit/answers`) that receives `GateAnswer` NDJSON lines pushed down from generacy-cloud through the authenticated relay `api_request` channel. Each answer is validated, deduped by `deliveryId`, and atomically appended to `/workspaces/.generacy/cockpit/answers.ndjson`. The file rotates at a size cap and retains N most-recent rotated siblings.
3. **Route auth** rides on the existing `apiKeyStore` + `authMiddleware`; a new `COCKPIT_INTERNAL_API_KEY` env var registers the MCP-side key using the same shape as `ORCHESTRATOR_INTERNAL_API_KEY` (#598).
4. **No relay-bridge route entry** is added — the dispatcher's implicit `orchestratorUrl` fallback already delivers `/cockpit/*` to the orchestrator with the full path preserved.

Downstream (out of scope here): the cockpit MCP tools that call these routes, the doorbell that tails `answers.ndjson`, and the cloud-side inbox UI. Each is a separate issue on the epic.

## Technical context

**Language/runtime**: TypeScript, Node.js ≥22, ESM. Fastify 5.x, Zod 3.x, `ws`, `node:http`, `node:fs`, `node:fs/promises`.

**Packages touched**:
- `packages/cockpit` — new `src/gates/` subtree exporting Zod schemas + inferred types for `GateOpen`, `GateAck`, `GateAnswer`. Consumed by the orchestrator routes; will also be consumed by the future MCP tools (out of scope for this PR).
- `packages/orchestrator` — three new routes + one retention module + one answers-file writer service + one line in `internal-relay-events.ts` allow-list + one block in `server.ts` for the new API key.

**No new runtime deps.** All work uses `zod` (already a workspace dep) and Node built-ins (`fs`, `path`, `crypto` for `deliveryId` handling).

**Relay wire shape** (already established, unchanged by this PR): `client.send({ type: 'event', event: 'cluster.cockpit', data, timestamp })`. Confirmed against `packages/orchestrator/src/routes/internal-relay-events.ts:48-53` and the #600 fix note in CLAUDE.md.

**Answers-file path**: `/workspaces/.generacy/cockpit/answers.ndjson` by default, overridable via `COCKPIT_ANSWERS_FILE`. Parent dir created on first write (`fs.mkdir` with `recursive: true`). Mode `0644` per spec.

## Project structure

```
packages/
├─ cockpit/
│  └─ src/
│     ├─ gates/                              [NEW]
│     │  ├─ schema.ts                        Zod: GateOpenSchema, GateAckSchema,
│     │  │                                   GateAnswerSchema; inferred TS types.
│     │  └─ index.ts                         Barrel re-export.
│     └─ index.ts                            Add `export * from './gates/index.js'`.
│
└─ orchestrator/
   └─ src/
      ├─ routes/
      │  ├─ cockpit-gates.ts                 [NEW] setupCockpitGatesRoute(server, deps).
      │  │                                   Handles POST /cockpit/gates and
      │  │                                   POST /cockpit/gates/:id/ack.
      │  ├─ cockpit-answers.ts               [NEW] setupCockpitAnswersRoute(server, deps).
      │  │                                   Handles POST /cockpit/answers.
      │  ├─ retained-cockpit-events.ts       [NEW] Bounded FIFO retain queue for
      │  │                                   cluster.cockpit events. Exports
      │  │                                   enqueueRetained(), replayRetained(),
      │  │                                   clearRetained(), sizeInfo(). NOT the
      │  │                                   single-slot pattern from
      │  │                                   retained-tunnel-event.ts.
      │  └─ internal-relay-events.ts         [MODIFIED] Add 'cluster.cockpit' to
      │                                      ALLOWED_CHANNELS. No structural change.
      │
      ├─ services/
      │  ├─ cockpit-answers-writer.ts        [NEW] CockpitAnswersWriter class.
      │  │                                   append(line), rotation, dedup rebuild on
      │  │                                   boot, in-memory Set<string> for
      │  │                                   deliveryId.
      │  └─ relay-bridge.ts                  [MODIFIED] After handleConnected() calls
      │                                      replayRetainedTunnelEvent(), also call
      │                                      replayRetainedCockpitEvents(this.client).
      │                                      Additive, no removals.
      │
      ├─ server.ts                           [MODIFIED] Two edits:
      │                                      1. Register COCKPIT_INTERNAL_API_KEY in
      │                                         the same block as
      │                                         ORCHESTRATOR_INTERNAL_API_KEY
      │                                         (~lines 780-790).
      │                                      2. Wire setupCockpitGatesRoute() and
      │                                         setupCockpitAnswersRoute() before
      │                                         server.listen(), passing the
      │                                         relayClientRef getter (same pattern
      │                                         as setupInternalRelayEventsRoute).
      │
      └─ __tests__/
         ├─ routes/
         │  ├─ cockpit-gates.test.ts          [NEW]
         │  └─ cockpit-answers.test.ts        [NEW]
         ├─ retained-cockpit-events.test.ts  [NEW] FIFO order, count/byte caps,
         │                                   drop-oldest, replay on connect.
         └─ services/
            └─ cockpit-answers-writer.test.ts [NEW] Append, dedup, rotation,
                                             cross-restart boot scan.

specs/1021-part-cockpit-remote-gates/
├─ spec.md                                    [READ-ONLY]
├─ clarifications.md                          [READ-ONLY]
├─ plan.md                                    [THIS FILE]
├─ research.md                                [NEW]
├─ data-model.md                              [NEW]
├─ contracts/
│  ├─ post-cockpit-gates.md                   [NEW]
│  ├─ post-cockpit-gates-ack.md               [NEW]
│  ├─ post-cockpit-answers.md                 [NEW]
│  └─ cluster-cockpit-event.md                [NEW]
└─ quickstart.md                              [NEW]

.changeset/
└─ 1021-cockpit-remote-gates.md               [NEW at implement phase]
                                              Bump: @generacy-ai/orchestrator minor,
                                              @generacy-ai/cockpit minor.
```

## Component contracts (summary — full schemas in `contracts/`)

### `POST /cockpit/gates`

- **Auth**: `authMiddleware` via `COCKPIT_INTERNAL_API_KEY` (scope: `admin` or a narrower future scope; `admin` for parity with `ORCHESTRATOR_INTERNAL_API_KEY`).
- **Body**: `GateOpenSchema.parse(request.body)`. Reject with `400 { error, code: 'VALIDATION', details }` on failure.
- **Behavior**: on success, either `client.send({ type: 'event', event: 'cluster.cockpit', data, timestamp: new Date().toISOString() })` if `client && client.isConnected`, or enqueue into the retain queue. Response: `202 { accepted: true }`.

### `POST /cockpit/gates/:id/ack`

- **Auth**: same as above.
- **Body**: `GateAckSchema.parse({ ...request.body, gateId: request.params.id })` — path param merged into body under `gateId` before parsing so the schema owns the field's presence. Reject `400` on validation mismatch (including mismatch between path and body `gateId` if both are present).
- **Behavior**: same emit/retain path as `/cockpit/gates`. Response: `202 { accepted: true }`.

### `POST /cockpit/answers`

- **Auth**: same `authMiddleware`. The relay reaches the orchestrator on `127.0.0.1` with a header-forwarded API key; no separate relay-side scope is added in this PR.
- **Body**: `GateAnswerSchema.parse(request.body)`. Reject `400` with structured log; **nothing written**.
- **Behavior**:
  - Compute `deliveryId` from the parsed payload. If `writer.hasDelivered(deliveryId)` → respond `200 { accepted: true, deduped: true }`; do not write.
  - Otherwise: `await writer.append(payload)`. Response: `200 { accepted: true, deduped: false }`.
  - Write is atomic per FR-011: single `fs.write(fd, buffer)` of `JSON.stringify(payload) + '\n'` (no partial lines). Rotation check runs after the append.

### `cluster.cockpit` relay channel

- **Wire**: `{ type: 'event', event: 'cluster.cockpit', data, timestamp: ISO8601 }`. `data` is the exact validated payload from `POST /cockpit/gates` or `POST /cockpit/gates/:id/ack` — the channel is content-agnostic and the cloud discriminates on payload shape.
- **Allow-list**: add `'cluster.cockpit'` to `ALLOWED_CHANNELS` in `internal-relay-events.ts`. This is defensive — the direct emit path from the new routes bypasses `/internal/relay-events`, but a future MCP could plausibly use the internal HTTP forwarder, so the allow-list stays a single source of truth.
- **Retention**: FIFO queue, bounded by `count` **and** `bytes`. Drop-oldest with a `warn` log when either cap is exceeded. No dedup — the cloud upserts by `gateId` (per Q1→A).

### Answers-file writer

- **Path**: `COCKPIT_ANSWERS_FILE` or `/workspaces/.generacy/cockpit/answers.ndjson`.
- **Rotation threshold**: `COCKPIT_ANSWERS_ROTATION_BYTES` (default 32 MiB — matches typical NDJSON rotation and gives the doorbell a reasonable catch-up horizon without unbounded disk).
- **Retention**: keep N most-recent rotated files. `COCKPIT_ANSWERS_ROTATION_KEEP` (default 3, per Q2→A).
- **Rotation mechanics**: promote `.N-1` → `.N`, unlink displaced `.N`, then rename current to `.1`. Rotation runs synchronously inside the append critical section (a per-writer mutex or an async serialization queue) so no concurrent append can race the rename.
- **Dedup rebuild**: on `writer.init()`, stream `answers.ndjson` line-by-line (only the current file, per Q3→A), parse `deliveryId`, populate the in-memory `Set<string>`. Rotated siblings are **not** scanned — the doorbell/cloud replay is authoritative for cross-restart dedup on rotated content.
- **Directory bootstrap**: `fs.mkdir('/workspaces/.generacy/cockpit', { recursive: true, mode: 0o755 })` on `init()`. File `chmod` to `0o644` after first `open` per FR-002.

## Constitution check

No `.specify/memory/constitution.md` exists at branch head. Nothing to check against.

Local invariants I'm enforcing anyway:

1. **Zero new runtime deps.** All work uses `zod` + Node built-ins.
2. **No skipRoutes changes.** `/cockpit/*` inherits the existing `authMiddleware` (per Q4→C).
3. **No relay-bridge route entry.** Dispatcher fallback handles `/cockpit/answers` (per Q5→A). Confirmed against `packages/cluster-relay/src/proxy.ts:166-168` — unmatched prefixes go to `${orchestratorUrl}${request.path}` with the full path preserved.
4. **Additive changes to `retained-tunnel-event.ts`?** *None.* The tunnel retention module stays single-slot; we add a **separate** FIFO module (`retained-cockpit-events.ts`) so tunnel semantics are not touched. See research.md §2 for the "why not merge them" argument.
5. **Changeset required.** `packages/orchestrator/src/` and `packages/cockpit/src/` both get non-test changes → `.changeset/1021-cockpit-remote-gates.md` bumps both packages `minor` (new capability, per CLAUDE.md gate).

## Risks & sequencing notes

- **Wire contracts live in a different repo.** Full field lists for `GateOpen`/`GateAck`/`GateAnswer` are in `docs/cockpit-remote-gates-plan.md` in the tetrad-development repo. The `contracts/` files in this spec dir define what the orchestrator sees on the wire and what it emits/writes; if the epic contract changes, the Zod schemas in `packages/cockpit/src/gates/` are the diff surface. Per the spec: *propose contract changes on the epic before diverging.*
- **Cross-package dependency.** `@generacy-ai/orchestrator` imports from `@generacy-ai/cockpit` for the gate schemas. Confirm `cockpit` is already a workspace dep of `orchestrator` at implement time — if not, add it before the code lands (a workspace `package.json` edit, not a runtime dep).
- **Test-hookable path config.** Tests need to point the writer at a temp dir. `CockpitAnswersWriter` takes its path + rotation config via constructor options (env var read is only in `server.ts`), so tests inject directly and never touch env.
- **Relay-client getter injection.** Both new route setup functions take a `getRelayClient: () => ClusterRelayClient | null` getter — same pattern as `setupInternalRelayEventsRoute` — so the routes register before `server.listen()` in wizard mode and don't fail when the client isn't ready yet (per #598).
- **No changes to `PostActivationRetryService` / `BootResumeService`.** The cockpit answers-file survives restart via the boot-time dedup scan; no lifecycle-action wiring needed.

## Post-plan gates

- `pnpm changeset` (or hand-write `.changeset/1021-cockpit-remote-gates.md`) at the *start* of implement, not the end — the CI gate rejects `packages/*/src/` diffs without a `--diff-filter=A` changeset.
- Run `pnpm -w -F @generacy-ai/orchestrator test -- --run` and `pnpm -w -F @generacy-ai/cockpit test -- --run` after the retention + writer modules land.
- No UI to smoke-test in this PR (cloud UI and doorbell are separate issues).

## Next step

Run `/speckit:tasks` to expand this plan into an ordered task list.
