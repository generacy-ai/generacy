# Contract: Route-side mint (D1)

**Feature**: #1077
**Consumers**: MCP tool callers (`cockpit_gate_open`, `cockpit_gate_ack`) and
any future direct HTTP caller of `POST /cockpit/gates` / `POST /cockpit/gates/:id/ack`.
**File**: `packages/orchestrator/src/routes/cockpit-gates.ts`

## Behaviour

For each of the two POST routes, on successful validation of the body against
`GateOpenSchema` / `GateOutcomeSchema`:

1. Compute `frameId`:
   - **If** `parsed.frameId` is a non-empty string (caller override, permitted
     since #1066 — the schema normalises `""` and `null` to `undefined` before
     the route sees it), **use it verbatim**.
   - **Otherwise**, mint via `` `frm_${randomBytes(12).toString('hex')}` `` (24
     hex chars entropy, `frm_` prefix — matches every #1066 fixture and
     disambiguates from bare-24-hex `gateId`s in log lines).
2. Register the pending correlation entry with the relay client — see
   `pending-map.md`. Null-guard the client (may be absent during boot);
   no-op if absent.
3. Assemble `emitData = { ...parsed, frameId }`. This is the object handed to
   `tryEmitOrRetain` — both the immediate `client.send({ ..., data: emitData })`
   path and the retainer `enqueue({ ..., data: emitData })` path see the same
   object, so retained frames replay with the same `frameId` (FR-008).
4. Reply on the 202 with `frameId` echoed in the body — see `wire-response.md`.

## Ordering invariants

- **Mint happens before `registerPendingFrame`** — the pending map cannot be
  keyed on a value the route has not decided yet.
- **`registerPendingFrame` happens before `tryEmitOrRetain`** — safer under a
  hypothetical zero-latency reply that races the register call, and preserves
  the invariant "for every outbound frame with a `frameId`, a pending entry
  exists at emit time" so the pending-map audit tests can assert on `pending.size`
  deterministically.
- **`emitData` reference is shared between `send()` and `enqueue()`** — the
  retain path is a byte-for-byte pass-through
  (`retained-cockpit-events.ts:64-87`). Do NOT clone/merge again inside
  `tryEmitOrRetain` — the shared reference is what FR-008 (retained-frame
  `frameId` preservation) rides on.

## Error handling

- Validation error before mint → existing 400 shape, no mint attempted, no
  pending entry, no `registerPendingFrame` call.
- Relay client null → no-op on `registerPendingFrame`; `tryEmitOrRetain`
  retains; response echoes `frameId` anyway (the id is decided in-process,
  independent of the client). When the client later attaches and drains, the
  reply for that frame hits the quiet-drop branch — same failure mode as a
  TTL expiry.
- `mintFrameId()` cannot fail — `node:crypto.randomBytes(12)` is synchronous
  and does not throw for a fixed byte length ≤ 65 536.

## Idempotency

Each mint produces a **new** `frameId`. Two POSTs with the same body (same
`gateId`, same everything) produce **two distinct** `frameId`s — this is FR-003,
the retry-collision defence that generacy-cloud#887 Q1 rejected the alternative
of.

## What the mint site does NOT do

- Does NOT check whether a pending entry already exists for the minted id
  (probability ~2^-96; not worth defending against).
- Does NOT persist the id anywhere on disk.
- Does NOT emit any metric — observability is via `info` log at settle time
  (see `pending-map.md`).
- Does NOT wait for a reply — the 202 is fire-and-forget by design (D2).

## Test surface

- `packages/orchestrator/src/routes/__tests__/cockpit-gates.test.ts` — new
  cases:
  - `POST /cockpit/gates` with no `frameId` in body → 202 body has a
    `frm_[a-f0-9]{24}` `frameId`; `getRelayClient().registerPendingFrame`
    invoked once with `(<same id>, { frameType: 'gate-open', gateId })`.
  - `POST /cockpit/gates` with caller-supplied `frameId: 'frm_wire_known'` →
    202 body carries that exact id; `registerPendingFrame` invoked with it.
  - `POST /cockpit/gates` with `frameId: null` → route mints (schema
    normalises null → undefined).
  - `POST /cockpit/gates` with `frameId: ''` → route mints (same
    normalisation).
  - Two consecutive POSTs with identical bodies → two distinct minted
    `frameId`s (FR-003 / SC-002).
  - Same matrix for `POST /cockpit/gates/:id/ack`.
  - Relay client returns `null` from `getRelayClient()` → 202 still carries
    a minted `frameId`; retainer receives an event with that id inside `data`.
- `packages/orchestrator/src/__tests__/cockpit-gates-frameid.integration.test.ts`
  — extend with:
  - POST without `frameId` → real relay peer sees `data.frameId` matching
    `/^frm_[a-f0-9]{24}$/` (SC-001 baseline).
  - Peer echoes `cluster.cockpit.reply { frameId: <received id>, accepted: true }`
    → orchestrator relay logger emits one `info` line naming that `frameId`
    ("settled").
  - Peer echoes with bogus `frameId: 'frm_ffff'` → one `info` line naming that
    id ("no matching pending frame"), no throw, no leaked pending entry
    (SC-003).
