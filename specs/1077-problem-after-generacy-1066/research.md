# Research: `frameId` mint + consume

**Feature**: #1077
**Status**: Complete

Prerequisite reading: `spec.md` (the feature) and `clarifications.md` (Q1–Q5
resolved decisions). This document records the **implementation-shaping
research** the clarifications did not exhaustively cover — code-site pins,
alternatives rejected, and the small handful of load-bearing choices the
resolved decisions cascade into.

## D-1. Mint site — the two handlers, before `tryEmitOrRetain`

**Decision**: Both `POST /cockpit/gates` and `POST /cockpit/gates/:id/ack`
handlers in `packages/orchestrator/src/routes/cockpit-gates.ts` mint the
`frameId` after `GateOpenSchema.parse` / `GateOutcomeSchema.parse` succeeds
and **before** `tryEmitOrRetain(...)` is called. The value is written onto
the parsed object so both branches of `tryEmitOrRetain` — the immediate
`client.send()` and the retainer `enqueue()` — see it inside `data`.

**Rationale**:
- Q1=C settled on route-mints-with-caller-override.
- Cloud reads `frameId` inside `data`, not on the envelope (`services/api/src/services/relay/message-handler.ts:804`). #1066 SC-001 already
  pins this at `packages/orchestrator/src/__tests__/cockpit-gates-frameid.integration.test.ts:61` (`received.data.frameId`, NOT `received.frameId`).
- Retained frames must carry the id: `packages/orchestrator/src/routes/retained-cockpit-events.ts:74` passes `data` through byte-for-byte. Minting **before** enqueue is the only way to make FR-008 hold without a second mutation
  site inside the retainer.

**Alternatives rejected**:
- **Mint inside `tryEmitOrRetain`**: would require re-parsing the object to
  inject the field, and would need to be idempotent against the retained-drain
  path. Additional mutation site with no benefit.
- **Mint at the MCP tool boundary (option A in Q1)**: leaves every non-updated
  caller with no `frameId`; correlation stays permanently partial. Explicitly
  rejected in Q1.

**Caller-override precedence**:
- Route reads `parsed.frameId`. Because `GateOpenSchema` / `GateOutcomeSchema`
  in `packages/cockpit/src/gates/schema.ts:77-84 / :98-105` already normalise
  `""` / `null` / omitted → `undefined`, the route only needs:
  ```ts
  const frameId = parsed.frameId ?? mintFrameId();
  ```
  No re-implementation of the normalisation logic.

**Code sites pinned** (checked live 2026-07-29):
- `packages/orchestrator/src/routes/cockpit-gates.ts:334` — `GateOpenSchema.parse`
- `packages/orchestrator/src/routes/cockpit-gates.ts:337` — `tryEmitOrRetain` for open
- `packages/orchestrator/src/routes/cockpit-gates.ts:413` — `GateOutcomeSchema.parse`
- `packages/orchestrator/src/routes/cockpit-gates.ts:416` — `tryEmitOrRetain` for outcome

## D-2. Pending-map ownership — `ClusterRelay`, not the orchestrator

**Decision**: The `Map<frameId, PendingFrame>` lives on the `ClusterRelay`
instance in `@generacy-ai/cluster-relay`. A new public method
`registerPendingFrame(frameId, meta)` lets the orchestrator route register an
entry immediately after mint. The existing `cluster.cockpit.reply` branch in
`packages/cluster-relay/src/relay.ts:334` looks up + settles + evicts.

**Rationale**:
- The reply-receiver at `:334` **must** own the settle path — the FR-003 /
  Q3=A test at `packages/cluster-relay/tests/relay.test.ts:830-892` pins that
  registered `onMessage` handlers do **not** see `cluster.cockpit.reply`
  frames (the branch is a structural early-return). Anything outside
  `ClusterRelay` cannot observe the reply.
- The mint site (orchestrator route) and the settle site (relay class) live
  in the **same** process — the orchestrator hosts the `ClusterRelay`
  instance. A single new method on the interface is the smallest wiring.
- Co-locating with `send()` gives the settle path exact knowledge of what was
  sent (`gateId`, `frameType`, timestamp) without threading meta through the
  route.

**Alternatives rejected**:
- **Pending map in the orchestrator, subscribed via `onMessage`**: does not
  work — see the FR-003 short-circuit above. Would require weakening the
  cluster-relay contract.
- **Callback plumbed from route into `send()`**: mixes concerns; the route
  would need to know how the map is keyed. Preferred keeping the wiring one
  method wide.
- **Standalone `PendingFrameCorrelator` module imported by both packages**:
  builds a helper for a two-caller problem. The `Map` is nine lines of code;
  a module hides that behind indirection.

## D-3. TTL enforcement — timer per entry vs. lazy sweep

**Decision**: Timer per entry (`setTimeout(30_000)`). On register, schedule
eviction; on settle, `clearTimeout` before deleting. On process exit /
`disconnect()`, clear all timers.

**Rationale**:
- Map size is single-digit at steady state (spec Assumption + clarifications
  Q5), so per-entry timer overhead is trivially bounded.
- Lazy sweep (evict on next `registerPendingFrame` call after checking `Date.now() - entry.registeredAt > TTL`) is a defensive optimisation for a
  problem that does not exist at this scale, and gives fuzzy eviction times
  that make FR-007's `debug` log ("evicted at 30s") a lie.
- `Node.js`'s timer wheel handles the scheduling — no external dep.

**Alternatives rejected**:
- **Single interval sweeping the map every N ms**: same map traversal cost
  at a coarser granularity, plus a persistent timer even when the map is
  empty. Not worth it.
- **`setImmediate` on eviction**: unnecessary; the timer callback runs
  synchronously enough at this scale.

## D-4. Log-level matrix — settle `info`, unknown `info`, TTL `debug`

**Decision** (from clarifications Q2 + Q3):

| Event | Level | Fields |
|---|---|---|
| Settle (matched frame) | `info` | `frameId, accepted, reason?, frameType, gateId, priorStatus?, ageMs` |
| Unknown reply (no matching entry) | `info` | `frameId, frameType, gateId, accepted, reason?, priorStatus?` |
| TTL eviction | `debug` | `frameId, ageMs` |

**Rationale**:
- Settle at `info` because it is the diagnostic signal an operator reads to
  confirm delivery. `debug` would make correlation invisible unless someone
  bumps log level.
- Unknown-reply at `info` because Q2's Action Item 2 is explicit: today's
  dropped-reply path at `relay.ts:334` is invisible; the whole point of D2 is
  to make it observable. `info` matches settle so an operator can grep on
  `frameId` and get a single line either way.
- TTL eviction at `debug` because a 30s TTL not covering a slow reply is a
  tuning question, not an incident. Q3 explicitly requires the log so tuning
  is data-driven.
- **`warn` / `error` are reserved**: the pending map does not throw and does
  not report failures; observability replaces the currently-invisible bug.

**Existing test impact**: `packages/cluster-relay/tests/relay.test.ts`'s two
`#1063` tests (`SC-001 accepted:true → debug`, `SC-002 accepted:false → info
"cluster.cockpit.reply dropped"`) MUST be rewritten. Under the new behaviour:
- Reply with `frameId: null` and a pending entry does not exist → falls into
  the "unknown reply" branch → **one `info` line** with the reply fields.
- Reply with a `frameId` matching a registered entry → **one `info` line**
  ("settled") with the settle fields.
- The current `debug` line ("cluster.cockpit.reply received") disappears —
  the new settle line at `info` supersedes it.

Update the tests to assert the new shapes; the load-bearing invariant
(handlers do NOT see the reply — FR-003 test at `:830`) stays green
unmodified.

## D-5. Wire-schema surface — optional `frameId` on the tool wire schemas

**Decision**: Add optional `frameId: z.string().min(1).optional()` to both
`GateOpenWireSchema` (`packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:142`) and
`GateOutcomeWireSchema` (`:193`). Type-only impact on `GateOpenWire` /
`GateOutcomeWire`.

**Rationale**:
- The **route-side** `GateOpenSchema` / `GateOutcomeSchema` (in
  `packages/cockpit/src/gates/schema.ts:53-84 / :91-105`) already accept
  `frameId` (#1066). No change needed there.
- The **tool-side** wire schemas are the tool's self-check; without the
  optional field, a tool that later hand-supplies a `frameId` (spec §Required
  change item 1, "Caller sites remain the natural place to *supply* an id
  when one is needed") would fail its own `safeParse` before the POST.
- SC-006 (`grep -rn 'frameId' packages/generacy/src` returns non-zero) is
  satisfied by this schema addition alone; the two tool call sites do not
  have to change to hit SC-006.

**Alternatives rejected**:
- **Leave the tool schemas alone and rely on route mint only**: the
  caller-override path becomes vestigial — you cannot exercise it from the
  MCP tool without stripping the wire self-check. Small surface, real
  brittleness.
- **Make `frameId` required on the tool schemas + mint at the tool**: that
  is option A in Q1, explicitly rejected.

## D-6. Response body — echo `frameId` on the 202

**Decision**: Both handlers return `{ accepted, retained, frameId, retainQueue? }`.
The `GateOpenResponseSchema` at
`packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:215-217` already
uses `.passthrough()`, so the field passes through without a schema change; the
type just becomes non-empty. `GateAckResponseSchema` is `z.record(z.unknown())`
— same, no schema change.

**Rationale**:
- Q1=C's mint-at-route point requires the 202 to carry the id: "the 202 can
  echo the id back, a retained frame carries its id into the retain queue, and
  drain emits it verbatim."
- Echoes let the caller correlate its own logs (`cockpit_gate_open` logs
  `runIdSource` at `:88-97` alongside `gateId`; adding the echoed `frameId`
  from the response body gives the caller the id the pending map is keyed on).

**Alternatives rejected**:
- **Don't echo — logs are enough**: the caller would have no per-call handle
  to grep on. Cheap to do, so do it.

## D-7. Retained-frame replay path — no code change, one test

**Decision**: The retain path in
`packages/orchestrator/src/routes/retained-cockpit-events.ts` needs zero code
change — `drainInto` at `:64-87` already passes `head.data` through byte-for-byte,
and the enqueued object is the same reference the route wrote `frameId` onto
before `tryEmitOrRetain`.

**Rationale**:
- `packages/orchestrator/src/routes/__tests__/retained-cockpit-events.test.ts:149-181`
  already pins byte-for-byte preservation of `frameId` in enqueue → drain
  (#1066 FR-008 guardrail).
- The only *new* invariant this feature adds is that after reconnect + drain,
  the pending map created by the original send **still holds** an entry keyed
  by the drained frame's `frameId` (so the cloud's eventual reply settles it).
  This is a test-only assertion (SC-005), not a code change: the `Map` outlives
  the disconnect because it is instance-scoped on the always-alive
  `ClusterRelay`.

**Alternatives rejected**:
- **Move the pending map onto the retainer**: conflates the two responsibilities
  (queueing vs. correlation). Retainer stays the pure FIFO it is today.

## D-8. `frameId` generator — `frm_${randomBytes(12).toString('hex')}`

**Decision** (from Q4=B + `frm_` prefix): 24 hex chars of entropy, `frm_`
prefix. `node:crypto.randomBytes(12).toString('hex')`. Zero new dependencies.

**Rationale**:
- Matches the existing `gateId` convention (24-hex derived from SHA-256).
- Matches every merged #1066 fixture (`frm_abc`, `frm_xyz`, `frm_open_known`,
  `frm_ack_known`, `frm_wire_known`, `frm_kept`) — a de-facto convention.
- Prefix disambiguates from bare-24-hex `gateId` in log lines where both
  appear — the operator log line at settle time carries both.

**Alternatives rejected**:
- `crypto.randomUUID()` — introduces hyphens (grep-hostile), 36 chars not 24
  (drift from `gateId`), no functional benefit.
- ULID — new dependency for lex-sortability that logs already deliver via
  timestamps.
- `{processNonce}-{counter}` — not unique across restarts, and restarts are
  exactly when retained frames drain.

## D-9. Test topology — extend existing fixtures, don't stand up new ones

**Decision**: Reuse two existing test fixtures:
- `packages/orchestrator/src/__tests__/cockpit-gates/scenario-helpers.ts` —
  the #1024 real-WS harness (`setupScenario`, `waitFor`, `FakePeer`). Extend
  `cockpit-gates-frameid.integration.test.ts` to (a) drive an outbound
  `gate-open`, (b) have the peer echo `cluster.cockpit.reply { frameId }`,
  (c) assert the settle log surface via the injected `SILENT_LOGGER` slot
  (upgrade to a spying logger for the pending-map tests).
- `packages/cluster-relay/tests/relay.test.ts` — reuse `startServer` +
  `createConfig` + `waitFor` for the pending-map unit tests. The existing
  `#1063 router branch` describe block gets extended.

**Rationale**:
- The #1024 harness already spins up a `WebSocketServer` on port 0 and wires a
  real `ClusterRelayClient` at the fake peer. Adding a settle-echo scenario is
  a delta, not a new fixture.
- SC-001 explicitly requires **not** a `vi.fn()` echoing its own argument.
- Two-package split of the pending-map tests (unit in cluster-relay, integration
  in orchestrator) mirrors #1024's split.

**Alternatives rejected**:
- **New standalone harness under `packages/cluster-relay/tests/pending-map/`**:
  more infra, no reuse of the WS-server helpers. Rejected.

## D-10. Comment cleanup — name #1077 explicitly

**Decision**: Replace the `relay.ts:330-333` comment with:

```ts
// Cloud-sent gate acknowledgement (#1063 + #1077). #1077 wires the
// frameId-keyed pending map: settle on match, quiet-drop on miss.
// The return is structural (Q3=A / FR-003) — registered onMessage
// handlers must not observe cluster.cockpit.reply.
```

**Rationale**:
- FR-009 requires this issue's number (or the specific work item it produced)
  to name the wiring ticket, not #1059 steps 4-7.
- Keeping the "structural return" clause is load-bearing: the FR-003 test at
  `packages/cluster-relay/tests/relay.test.ts:830` pins it, and the comment
  is the on-file record of why.
- SC-007 (`grep -n '#1059 steps 4-7' packages/cluster-relay/src/relay.ts`
  returns nothing) is the acceptance signal.

## Sources / cross-refs

- Spec (this feature): `specs/1077-problem-after-generacy-1066/spec.md`
- Clarifications (this feature): `specs/1077-problem-after-generacy-1066/clarifications.md`
- #1066 wire preservation SC-001 test: `packages/orchestrator/src/__tests__/cockpit-gates-frameid.integration.test.ts`
- #1066 retain-path pin: `packages/orchestrator/src/routes/__tests__/retained-cockpit-events.test.ts:149-181`
- #1063 router-branch tests: `packages/cluster-relay/tests/relay.test.ts:714-893`
- #1024 real-WS harness: `packages/orchestrator/src/__tests__/cockpit-gates/scenario-helpers.ts`
- Cloud-side reply producer (out of scope but referenced): `generacy-cloud#890` — echoes `frameId` from `services/api/src/services/relay/message-handler.ts:804`.
