# Clarifications: Cockpit gate routes, `cluster.cockpit` relay channel, answers-file writer

**Issue**: [#1021](https://github.com/generacy-ai/generacy/issues/1021) | **Branch**: `1021-part-cockpit-remote-gates`

## Batch 1 — 2026-07-21

### Q1: Retain-and-replay semantics for `cluster.cockpit`
**Context**: FR-005 says the retention pattern follows `cluster.vscode-tunnel` (`retained-tunnel-event.ts`), which is a **single-slot** store with terminal/pending dedup — the last relevant event wins. But the same FR-005 (and SC-003) require **preservation of emission order** and re-send on handshake, and FR-014 caps a count/bytes with drop-oldest. Those are queue semantics, not single-slot semantics. A gate-open followed by an ack during the same outage must both reach the cloud in order; a fresh gate-open must never overwrite a still-pending prior gate-open. The choice determines the entire retention module's shape, dedup rules, and every replay-order test.

**Question**: What is the concrete retention shape for `cluster.cockpit` events emitted while `relay.isConnected === false`?
**Options**:
- A: Single ordered FIFO queue over all `cluster.cockpit` events, bounded by count/bytes (FR-014), drop-oldest with a warn log when the cap is exceeded. No per-event dedup; ordering across gate-open/ack pairs is guaranteed by insertion order. `vscode-tunnel`'s single-slot logic is not reused.
- B: Per-`gateId` slot map with an ordered index. For each `gateId`, keep the latest open + the latest ack (or fold ack over open if present). Replay iterates slots in first-touched order. Reduces duplicate opens for the same gate but discards intermediate opens.
- C: Two-slot pattern *literally* mirroring `vscode-tunnel` (one retained event, replaced by newer). Sacrifices multi-gate correctness — an ack for gate A followed by an open for gate B during the outage would drop the gate A ack. (Included only if the spec's "same pattern" language is taken literally.)
- D: Other (specify).

**Answer**: *Pending*

---

### Q2: Answers-file rotation retention policy
**Context**: FR-010 requires rotation to a numbered sibling (`answers.ndjson.1`) once a size cap is crossed, and SC-005 asserts the tail resumes on the new file without dropping in-flight answers. But nothing specifies how many rotated files are kept, when they are pruned, or whether pruning is size-bounded or count-bounded. The doorbell (a separate follow-up issue) will tail rotated files across restart, so the writer's retention policy directly determines what history a slow consumer can still see.

**Question**: What is the retention policy for rotated answers files?
**Options**:
- A: Keep the **N most-recent** rotated files (e.g., N = 3, configurable via env var); on rotation, promote `.N-1` → `.N`, drop `.N`. Simple, bounded disk footprint (~N × threshold).
- B: Keep files until **total on-disk size** across `answers.ndjson*` exceeds a second configurable cap; prune oldest numbered siblings until under cap.
- C: Keep **all** rotated files indefinitely; operators prune manually. Zero-drop guarantee for arbitrarily slow consumers but unbounded disk.
- D: Keep only the current file and one immediate predecessor (`answers.ndjson.1`); on next rotation, unlink `.1` then rename. Minimal footprint; requires the doorbell to be actively tailing.
- E: Other (specify).

**Answer**: *Pending*

---

### Q3: `deliveryId` dedup: persistence and cross-restart behavior
**Context**: FR-007 and the Assumptions section conflict. FR-007: "Dedup state may be persisted alongside the answers file to survive orchestrator restarts." Assumptions: "The orchestrator process itself is authoritative for `deliveryId` dedup within a single run; cross-restart dedup is provided by the append-only file (readers skip already-processed lines by `deliveryId`)." These describe two different dedup owners. On restart, does the writer rebuild an in-memory set by scanning `answers.ndjson` (and rotated siblings?), or does it maintain a sidecar (SQLite / dbm / a second NDJSON of processed IDs), or does it accept that cross-restart dedup is the reader's problem and cheerfully double-append?

**Question**: How does `POST /cockpit/answers` dedup by `deliveryId` across orchestrator restart?
**Options**:
- A: Rebuild in-memory dedup set at boot by scanning `answers.ndjson` (current file only). Rotated files not scanned — after a rotation, only the reader's own bookkeeping can catch a duplicate whose original write landed in `.1`. Cheap and correct in the common case.
- B: Rebuild in-memory dedup set at boot by scanning **all** `answers.ndjson*` files (current + all retained rotations). Fully cross-restart correct up to retention horizon, at the cost of a bounded boot-time scan.
- C: Maintain a sidecar dedup file (e.g. `answers.ndjson.dedup` — a compact set/log of processed `deliveryId`s), updated in the same append critical section as the main file. Constant-time lookup, rotates alongside the main file, larger implementation surface.
- D: In-memory only; on restart, dedup starts empty and the reader (doorbell / cloud replay strategy) is authoritative for cross-restart dedup. Matches the Assumptions text literally; makes FR-007's "may be persisted" a definite "isn't".
- E: Other (specify).

**Answer**: *Pending*

---

### Q4: Localhost enforcement for `/cockpit/gates` and `/cockpit/gates/:id/ack`
**Context**: FR-001 says the gate routes are "localhost-callable by the in-cluster MCP server; no auth beyond the socket boundary." But the orchestrator's public Fastify listens on a network port (see `server.ts` `server.listen(...)`), reachable by everything in the container network — not by a Unix socket. Anything reachable at that port can currently POST a gate. The security model needs a concrete rule the route can enforce; this determines whether we add a network-binding change, an origin check, an API-key check, or nothing at all.

**Question**: How does the orchestrator enforce the "localhost boundary" for the gate-open and gate-ack routes?
**Options**:
- A: Enforce **at the socket layer** — bind the gate routes to a separate Unix socket (or to `127.0.0.1` explicitly). Requires either splitting into a second Fastify instance or moving the routes to the existing control-plane pattern. Strongest boundary.
- B: Enforce **at the route layer** — an `onRequest` guard on `/cockpit/gates*` that rejects anything whose `request.ip` is not loopback (`127.0.0.1` / `::1`). Simple, unchanged network binding, but relies on Fastify's reported IP (correct behind no proxy).
- C: Enforce **at the API-key layer** — reuse the existing `apiKeyStore` pattern (see `ORCHESTRATOR_INTERNAL_API_KEY` per #598) with a new `COCKPIT_INTERNAL_API_KEY` the in-cluster MCP reads from a shared file. Independent of network topology; matches the internal-relay-events precedent.
- D: **No enforcement in this phase** — accept that any in-cluster caller can post gates; document the trust boundary and defer hardening to a follow-up. Matches FR-001's literal "no auth beyond the socket boundary" if the socket boundary is interpreted as the cluster boundary.
- E: Other (specify).

**Answer**: *Pending*

---

### Q5: Relay routing for `POST /cockpit/answers`
**Context**: The Assumptions section says `POST /cockpit/answers` "is reachable via the existing relay path-prefix dispatcher pattern (same mechanism as `/control-plane/*` per #574 and `/code-server/*` per #586)." But those existing prefixes route the request off the orchestrator to a **different Unix socket** — `/cockpit/answers` is served **by the orchestrator itself** (same process that owns `/cockpit/gates`). The dispatcher already has an `orchestratorUrl` implicit fallback for unmatched prefixes (see `packages/cluster-relay/src/dispatcher.ts`). The choice determines whether `initializeRelayBridge()` grows a new route entry or not.

**Question**: How is `POST /cockpit/answers` reached from the cloud via the relay?
**Options**:
- A: **Implicit fallback** — no route entry needed; the dispatcher's `orchestratorUrl` default catches `/cockpit/answers` (and `/cockpit/gates*` if the cloud ever calls them, which it shouldn't). Fewer moving parts; relies on `/cockpit/*` not being claimed by any other prefix.
- B: **Explicit `/cockpit` prefix → orchestrator** — add `{ prefix: '/cockpit', target: 'http://127.0.0.1:<orchestrator-port>' }` to `initializeRelayBridge()` routes. Strips the prefix (so `/cockpit/answers` on the wire becomes `/answers` on Fastify — meaning Fastify must register the route as `/answers`, not `/cockpit/answers`). Symmetric with the `/control-plane/*` pattern but changes route paths.
- C: **Explicit `/cockpit/answers` prefix → orchestrator with no strip** — a dispatcher change or a route entry that preserves the full path. Explicit and symmetric with A's Fastify path but a new dispatcher shape.
- D: Other (specify).

**Answer**: *Pending*

---
